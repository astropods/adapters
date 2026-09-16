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
  return { urls, tools: sandboxTools({ client }) };
}

// Mastra calls execute(inputData, context). The context type is wide, so this
// passes only the field the tools read.
type Execute = (input: unknown, context?: { threadId?: string }) => Promise<unknown>;
const call = (tool: unknown, input: { context: unknown; threadId?: string }) =>
  (tool as { execute: Execute }).execute(input.context, { threadId: input.threadId });

describe("mastra sandboxTools", () => {
  test("exposes the whole toolset keyed by name", () => {
    const { tools } = harness([attachResponse]);

    expect(Object.keys(tools).sort()).toEqual([
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
  });

  test("the thread id is the sandbox name, with no mapping table", async () => {
    const { urls, tools } = harness([
      attachResponse,
      () => json({ exit_code: 0, stdout: "", stderr: "", duration_ms: 1 }),
    ]);

    await call(tools.sandbox_exec, {
      context: { command: "true" },
      threadId: "thread-42",
    });

    expect(urls[0]).toBe(`${SERVER}/api/v1/sandboxes/thread-42`);
  });

  test("two threads never land on one sandbox", async () => {
    const { urls, tools } = harness([
      attachResponse,
      () => json({ exit_code: 0, stdout: "", stderr: "", duration_ms: 1 }),
    ]);

    await call(tools.sandbox_exec, { context: { command: "true" }, threadId: "thread-a" });
    await call(tools.sandbox_exec, { context: { command: "true" }, threadId: "thread-b" });

    const attached = urls.filter((u) => u.startsWith(SERVER));
    expect(attached).toEqual([
      `${SERVER}/api/v1/sandboxes/thread-a`,
      `${SERVER}/api/v1/sandboxes/thread-b`,
    ]);
  });

  test("a turn with no thread fails loudly instead of sharing one sandbox", async () => {
    const { tools } = harness([attachResponse]);

    await expect(
      call(tools.sandbox_exec, { context: { command: "true" } }),
    ).rejects.toThrow(/thread id/);
  });

  test("an explicit sandbox name overrides the thread id", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      urls.push(String(input));
      return urls.length === 1
        ? attachResponse()
        : json({ exit_code: 0, stdout: "", stderr: "", duration_ms: 1 });
    }) as unknown as typeof fetch;

    const tools = sandboxTools({
      client: new SandboxClient({ identityToken: deployToken(), fetchImpl }),
      sandbox: "pinned",
    });
    await call(tools.sandbox_exec, { context: { command: "true" }, threadId: "ignored" });

    expect(urls[0]).toBe(`${SERVER}/api/v1/sandboxes/pinned`);
  });

  test("spawn, poll and kill drive a background process", async () => {
    const { urls, tools } = harness([
      attachResponse,
      () => json({ process_id: "p1", state: "running", command: ["x"], started_at: "t" }, 201),
      () =>
        json({
          process_id: "p1",
          state: "exited",
          exit_code: 0,
          command: ["x"],
          started_at: "t",
          stdout: "done",
          stderr: "",
          stdout_next: 4,
          stderr_next: 0,
        }),
      () => new Response(null, { status: 204 }),
    ]);

    const spawned = (await call(tools.sandbox_spawn, {
      context: { command: "sleep 30" },
      threadId: "t1",
    })) as { process_id: string };
    expect(spawned.process_id).toBe("p1");

    const polled = (await call(tools.sandbox_poll, {
      context: { process_id: "p1", stdout_from: 0 },
      threadId: "t1",
    })) as { state: string; stdout: string; stdout_next: number };
    expect(polled.state).toBe("exited");
    expect(polled.stdout).toBe("done");
    expect(polled.stdout_next).toBe(4);

    await call(tools.sandbox_kill, { context: { process_id: "p1" }, threadId: "t1" });

    expect(urls.at(-1)).toBe("https://sb.example/v1/processes/p1");
  });

  test("the file tools are synthesized, so an agent never shells out to read", async () => {
    const encoded = Buffer.from("hello\n").toString("base64");
    const { tools } = harness([
      attachResponse,
      () => json({ exit_code: 0, stdout: encoded, stderr: "", duration_ms: 1 }),
    ]);

    const read = (await call(tools.sandbox_read_file, {
      context: { path: "/workspace/a.txt" },
      threadId: "t1",
    })) as { contents: string };

    expect(read.contents).toBe("hello\n");
  });
});
