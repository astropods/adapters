import { describe, expect, test } from "bun:test";

import { SandboxClient } from "./client";
import { SandboxNotEnabledError, SandboxRequestError } from "./types";

const SERVER = "https://app.astropods.com";

function deployToken(): string {
  const encode = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return [
    encode({ alg: "HS256", typ: "JWT" }),
    encode({ sub: "abc-def-ghi", iss: SERVER }),
    "signature",
  ].join(".");
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function stub(handlers: Array<(call: Call) => Response>) {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as string | undefined,
    };
    calls.push(call);
    const handler = handlers[Math.min(i++, handlers.length - 1)]!;
    return handler(call);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const attachResponse = (endpoint: string, token = "envd-1") =>
  json({
    name: "conv-1",
    class: "default",
    state: "running",
    endpoint,
    headers: { "X-aws-proxy-auth": "jwe", "X-aws-proxy-port": "49983", "X-Access-Token": token },
    expires_at: "2026-09-16T12:00:00Z",
  });

function client(fetchImpl: typeof fetch) {
  return new SandboxClient({ identityToken: deployToken(), fetchImpl });
}

describe("SandboxClient", () => {
  test("takes the server URL from the token so nothing has to configure it", async () => {
    const { calls, fetchImpl } = stub([() => attachResponse("sb.example")]);
    await client(fetchImpl).attach("conv-1");

    expect(calls[0]!.url).toBe(`${SERVER}/api/v1/sandboxes/conv-1`);
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${deployToken()}`);
  });

  test("adds the scheme the control plane leaves off", async () => {
    const { fetchImpl } = stub([() => attachResponse("sb.example")]);
    const handle = await client(fetchImpl).attach("conv-1");

    expect(handle.endpoint).toBe("https://sb.example");
  });

  test("keeps an endpoint that already carries a scheme", async () => {
    const { fetchImpl } = stub([() => attachResponse("https://sb.example")]);
    const handle = await client(fetchImpl).attach("conv-1");

    expect(handle.endpoint).toBe("https://sb.example");
  });

  test("sends every credential the handle carries, without reading them", async () => {
    const { calls, fetchImpl } = stub([
      () => attachResponse("sb.example"),
      () => json({ exit_code: 0, stdout: "hi\n", stderr: "", duration_ms: 3 }),
    ]);

    const result = await client(fetchImpl).exec("conv-1", { command: ["/bin/echo", "hi"] });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hi\n");
    const exec = calls[1]!;
    expect(exec.url).toBe("https://sb.example/v1/exec");
    expect(exec.headers["X-aws-proxy-auth"]).toBe("jwe");
    expect(exec.headers["X-aws-proxy-port"]).toBe("49983");
    expect(exec.headers["X-Access-Token"]).toBe("envd-1");
  });

  test("attaches once and reuses the handle across turns", async () => {
    const { calls, fetchImpl } = stub([
      () => attachResponse("sb.example"),
      () => json({ exit_code: 0, stdout: "", stderr: "", duration_ms: 1 }),
      () => json({ exit_code: 0, stdout: "", stderr: "", duration_ms: 1 }),
    ]);

    const c = client(fetchImpl);
    await c.exec("conv-1", { command: ["/bin/true"] });
    await c.exec("conv-1", { command: ["/bin/true"] });

    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  });

  test("re-attaches once when the sandbox refuses stale credentials", async () => {
    // Credentials expire in minutes and a sandbox past its ceiling is
    // replaced, so a 401 is ordinary rather than fatal.
    const { calls, fetchImpl } = stub([
      () => attachResponse("sb-old.example", "envd-old"),
      () => json({ error: "unauthorized" }, 401),
      () => attachResponse("sb-new.example", "envd-new"),
      () => json({ exit_code: 0, stdout: "after", stderr: "", duration_ms: 2 }),
    ]);

    const result = await client(fetchImpl).exec("conv-1", { command: ["/bin/true"] });

    expect(result.stdout).toBe("after");
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(2);
    expect(calls[3]!.url).toBe("https://sb-new.example/v1/exec");
    expect(calls[3]!.headers["X-Access-Token"]).toBe("envd-new");
  });

  test("gives up after one re-attach rather than looping", async () => {
    const { calls, fetchImpl } = stub([
      () => attachResponse("sb.example"),
      () => json({ error: "unauthorized" }, 401),
      () => attachResponse("sb.example"),
      () => json({ error: "unauthorized" }, 401),
    ]);

    await expect(
      client(fetchImpl).exec("conv-1", { command: ["/bin/true"] }),
    ).rejects.toBeInstanceOf(SandboxRequestError);
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(2);
  });

  test("does not re-attach on a failure the sandbox reports about the command", async () => {
    const { calls, fetchImpl } = stub([
      () => attachResponse("sb.example"),
      () => json({ error: "command is required" }, 400),
    ]);

    await expect(
      client(fetchImpl).exec("conv-1", { command: [] }),
    ).rejects.toBeInstanceOf(SandboxRequestError);
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  });

  test("reports a disabled account as its own error", async () => {
    const { fetchImpl } = stub([() => json({ error: "sandboxes are not enabled" }, 409)]);

    await expect(client(fetchImpl).attach("conv-1")).rejects.toBeInstanceOf(
      SandboxNotEnabledError,
    );
  });

  test("names the status and the body when something other than the control plane answers", async () => {
    const { fetchImpl } = stub([
      () =>
        new Response("<!DOCTYPE html>\n<HTML><HEAD>403 Forbidden</HEAD></HTML>", {
          status: 403,
          headers: { "content-type": "text/html" },
        }),
    ]);

    const err = (await client(fetchImpl)
      .attach("conv-1")
      .catch((e) => e)) as SandboxRequestError;

    expect(err.status).toBe(403);
    expect(err.message).toContain("403 Forbidden");
    expect(err.message).toContain("HTTP 403");
  });

  test("passes a non-zero exit code through instead of throwing", async () => {
    const { fetchImpl } = stub([
      () => attachResponse("sb.example"),
      () => json({ exit_code: 3, stdout: "", stderr: "boom", duration_ms: 5 }),
    ]);

    const result = await client(fetchImpl).exec("conv-1", { command: ["/bin/false"] });

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe("boom");
  });

  test("reports a timed-out command as a result, not an error", async () => {
    const { fetchImpl } = stub([
      () => attachResponse("sb.example"),
      () => json({ exit_code: -1, stdout: "", stderr: "", duration_ms: 100, timed_out: true }),
    ]);

    const result = await client(fetchImpl).exec("conv-1", {
      command: ["/bin/sleep", "5"],
      timeoutMs: 100,
    });

    expect(result.timedOut).toBe(true);
  });

  test("lists and reads records without credentials in them", async () => {
    const { fetchImpl } = stub([
      () =>
        json({
          sandboxes: [
            {
              name: "conv-1",
              class: "default",
              state: "running",
              created_at: "2026-09-16T11:00:00Z",
              last_active_at: "2026-09-16T11:05:00Z",
              ceiling_at: "2026-09-16T19:00:00Z",
            },
          ],
        }),
    ]);

    const rows = await client(fetchImpl).list();

    expect(rows).toHaveLength(1);
    expect(rows[0]!.ceilingAt).toBe("2026-09-16T19:00:00Z");
    expect(JSON.stringify(rows[0])).not.toContain("jwe");
  });

  test("forgets the handle on delete so the next turn attaches again", async () => {
    const { calls, fetchImpl } = stub([
      () => attachResponse("sb.example"),
      () => new Response(null, { status: 204 }),
      () => attachResponse("sb.example"),
    ]);

    const c = client(fetchImpl);
    await c.attach("conv-1");
    await c.delete("conv-1");
    await c.attach("conv-1");

    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(2);
  });

  test("refuses to construct without a token rather than failing at the first call", async () => {
    expect(() => new SandboxClient({ identityToken: "not-a-token" })).toThrow();
  });
});
