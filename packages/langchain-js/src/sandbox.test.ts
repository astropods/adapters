import { describe, expect, test } from "bun:test";
import { SandboxClient } from "@astropods/adapter-core";

import { sandboxTools } from "./sandbox";

const SERVER = "https://app.astropods.com";

function deployToken(): string {
  const encode = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return [encode({ alg: "HS256" }), encode({ sub: "dep-1", iss: SERVER }), "sig"].join(".");
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const attachResponse = () =>
  json({
    name: "whatever",
    class: "default",
    state: "running",
    endpoint: "sb.example",
    headers: { "X-aws-proxy-auth": "jwe", "X-aws-proxy-port": "49983", "X-Access-Token": "envd" },
    expires_at: "2026-09-17T12:00:00Z",
  });

function harness(handlers: Array<() => Response>) {
  const urls: string[] = [];
  let i = 0;
  const fetchImpl = (async (input: string | URL) => {
    urls.push(String(input));
    return handlers[Math.min(i++, handlers.length - 1)]!();
  }) as unknown as typeof fetch;

  const client = new SandboxClient({ identityToken: deployToken(), fetchImpl });
  const tools = sandboxTools({ client });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  return { urls, tools, byName };
}

const thread = (id: string) => ({ configurable: { thread_id: id } });

describe("langchain sandboxTools", () => {
  test("exposes the whole toolset, each with a schema an LLM can fill", () => {
    const { tools } = harness([attachResponse]);

    expect(tools.map((t) => t.name).sort()).toEqual([
      "sandbox_exec",
      "sandbox_grep",
      "sandbox_kill",
      "sandbox_list_dir",
      "sandbox_poll",
      "sandbox_read_file",
      "sandbox_run",
      "sandbox_spawn",
      "sandbox_write_file",
    ]);
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.schema).toBeDefined();
    }
  });

  test("the thread id from configurable names the sandbox", async () => {
    const { urls, byName } = harness([
      attachResponse,
      () => json({ exit_code: 0, stdout: "ok", stderr: "", duration_ms: 1 }),
    ]);

    await byName.sandbox_exec!.invoke({ command: "true" }, thread("thread-7"));

    expect(urls[0]).toBe(`${SERVER}/api/v1/sandboxes/thread-7`);
  });

  test("two threads never land on one sandbox", async () => {
    const { urls, byName } = harness([
      attachResponse,
      () => json({ exit_code: 0, stdout: "", stderr: "", duration_ms: 1 }),
    ]);

    await byName.sandbox_exec!.invoke({ command: "true" }, thread("a"));
    await byName.sandbox_exec!.invoke({ command: "true" }, thread("b"));

    expect(urls.filter((u) => u.startsWith(SERVER))).toEqual([
      `${SERVER}/api/v1/sandboxes/a`,
      `${SERVER}/api/v1/sandboxes/b`,
    ]);
  });

  test("a run with no thread fails loudly instead of sharing one sandbox", async () => {
    const { byName } = harness([attachResponse]);

    await expect(byName.sandbox_exec!.invoke({ command: "true" })).rejects.toThrow(/thread id/);
  });

  test("read_file, list_dir and grep are synthesized, not raw shell", async () => {
    const encoded = Buffer.from("contents\n").toString("base64");
    const { byName } = harness([
      attachResponse,
      () => json({ exit_code: 0, stdout: encoded, stderr: "", duration_ms: 1 }),
    ]);

    const read = await byName.sandbox_read_file!.invoke({ path: "/a.txt" }, thread("t"));

    expect(JSON.parse(read as string)).toEqual({ contents: "contents\n" });
  });

  test("grep returning no match is an empty result, not a failure", async () => {
    const { byName } = harness([
      attachResponse,
      () => json({ exit_code: 1, stdout: "", stderr: "", duration_ms: 1 }),
    ]);

    const out = await byName.sandbox_grep!.invoke({ pattern: "nothing" }, thread("t"));

    expect(JSON.parse(out as string)).toEqual({ matches: [] });
  });

  test("spawn and poll carry the process id and offsets through", async () => {
    const { byName } = harness([
      attachResponse,
      () => json({ process_id: "p9", state: "running", command: ["x"], started_at: "t" }, 201),
      () =>
        json({
          process_id: "p9",
          state: "running",
          command: ["x"],
          started_at: "t",
          stdout: "partial",
          stderr: "",
          stdout_next: 7,
          stderr_next: 0,
        }),
    ]);

    const spawned = JSON.parse(
      (await byName.sandbox_spawn!.invoke({ command: "sleep 30" }, thread("t"))) as string,
    );
    expect(spawned.process_id).toBe("p9");

    const polled = JSON.parse(
      (await byName.sandbox_poll!.invoke({ process_id: "p9" }, thread("t"))) as string,
    );
    expect(polled.stdout).toBe("partial");
    expect(polled.stdout_next).toBe(7);
  });
});
