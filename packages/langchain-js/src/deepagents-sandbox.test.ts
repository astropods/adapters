import { describe, expect, test } from "bun:test";
import { BaseSandbox } from "deepagents";
import { SandboxClient } from "@astropods/adapter-core";

import { AstroSandbox } from "./deepagents-sandbox";

const SERVER = "https://app.astropods.com";

function deployToken(): string {
  const encode = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return [encode({ alg: "HS256" }), encode({ sub: "dep-1", iss: SERVER }), "sig"].join(".");
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const attached = () =>
  json({
    name: "thread-1",
    class: "default",
    state: "running",
    endpoint: "sb.example",
    headers: { "X-aws-proxy-auth": "jwe", "X-aws-proxy-port": "49983", "X-Access-Token": "envd" },
    expires_at: "2026-09-17T12:00:00Z",
  });

const exec = (stdout: string, exitCode = 0, stderr = "", truncated = false) =>
  json({ exit_code: exitCode, stdout, stderr, duration_ms: 3, truncated });

interface Call {
  url: string;
  body?: string;
}

function harness(handlers: Array<() => Response>) {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: init?.body as string | undefined });
    return handlers[Math.min(i++, handlers.length - 1)]!();
  }) as unknown as typeof fetch;

  const client = new SandboxClient({ identityToken: deployToken(), fetchImpl });
  return { calls, sandbox: new AstroSandbox({ name: "thread-1", client }) };
}

describe("AstroSandbox as a Deep Agents backend", () => {
  test("is a BaseSandbox, so createDeepAgent accepts it as a backend", () => {
    const { sandbox } = harness([attached]);

    expect(sandbox).toBeInstanceOf(BaseSandbox);
    expect(sandbox.id).toBe("thread-1");
  });

  test("execute returns one combined stream, as the protocol expects", async () => {
    const { calls, sandbox } = harness([attached, () => exec("out and err\n")]);

    const result = await sandbox.execute("echo out; echo err >&2");

    expect(result.output).toBe("out and err\n");
    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(false);
    // stderr is folded at the shell so the two stay interleaved.
    expect(JSON.parse(calls[1]!.body!).command[2]).toContain("exec 2>&1");
  });

  test("execute reports a non-zero exit rather than throwing", async () => {
    const { sandbox } = harness([attached, () => exec("nope\n", 2)]);

    const result = await sandbox.execute("false");

    expect(result.exitCode).toBe(2);
    expect(result.output).toBe("nope\n");
  });

  test("execute passes the truncation flag through", async () => {
    const { sandbox } = harness([attached, () => exec("a lot\n", 0, "", true)]);

    expect((await sandbox.execute("cat big")).truncated).toBe(true);
  });

  test("the base class builds ls on top of execute, not on our own tool", async () => {
    const { calls, sandbox } = harness([attached, () => exec("a.txt\nb.txt\n")]);

    await sandbox.ls("/workspace");

    // One exec, issued by BaseSandbox itself. Nothing in this package
    // implements ls.
    expect(calls.filter((c) => c.url.endsWith("/v1/exec"))).toHaveLength(1);
  });

  test("uploadFiles writes bytes and reports one result per file", async () => {
    const { calls, sandbox } = harness([attached, () => exec("")]);

    const results = await sandbox.uploadFiles([["/workspace/a.bin", new Uint8Array([1, 2, 3])]]);

    expect(results).toEqual([{ path: "/workspace/a.bin", error: null }]);
    const command = JSON.parse(calls[1]!.body!).command as string[];
    expect(command[2]).toContain(Buffer.from([1, 2, 3]).toString("base64"));
  });

  test("downloadFiles returns bytes unchanged, binary included", async () => {
    const bytes = new Uint8Array([0, 255, 10, 13]);
    const { sandbox } = harness([
      attached,
      () => exec(Buffer.from(bytes).toString("base64") + "\n"),
    ]);

    const results = await sandbox.downloadFiles(["/workspace/a.bin"]);

    expect(results[0]!.error).toBeNull();
    expect(Array.from(results[0]!.content!)).toEqual([0, 255, 10, 13]);
  });

  test("a missing file is file_not_found, not a thrown error", async () => {
    const { sandbox } = harness([
      attached,
      () => exec("", 1, "base64: /nope: No such file or directory"),
    ]);

    const results = await sandbox.downloadFiles(["/nope"]);

    expect(results[0]!.content).toBeNull();
    expect(results[0]!.error).toBe("file_not_found");
  });

  test("a directory and a permission failure each get their own reason", async () => {
    const dir = harness([attached, () => exec("", 1, "base64: /workspace: Is a directory")]);
    expect((await dir.sandbox.downloadFiles(["/workspace"]))[0]!.error).toBe("is_directory");

    const denied = harness([attached, () => exec("", 1, "base64: /root/x: Permission denied")]);
    expect((await denied.sandbox.downloadFiles(["/root/x"]))[0]!.error).toBe("permission_denied");
  });

  test("one bad path does not fail the whole batch", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) return attached();
      if (call === 2) return exec(Buffer.from("ok").toString("base64"));
      return exec("", 1, "No such file or directory");
    }) as unknown as typeof fetch;

    const sandbox = new AstroSandbox({
      name: "thread-1",
      client: new SandboxClient({ identityToken: deployToken(), fetchImpl }),
    });

    const results = await sandbox.downloadFiles(["/good", "/bad"]);

    expect(results[0]!.error).toBeNull();
    expect(results[1]!.error).toBe("file_not_found");
  });

  test("the backend names no transport header", async () => {
    const source = await Bun.file(
      new URL("./deepagents-sandbox.ts", import.meta.url).pathname,
    ).text();

    expect(source).not.toContain("X-aws-proxy");
    expect(source).not.toContain("X-Access-Token");
  });
});
