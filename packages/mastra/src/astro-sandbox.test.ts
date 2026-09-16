import { describe, expect, test } from "bun:test";
import { SandboxClient } from "@astropods/adapter-core";
import { MastraSandbox, ProcessHandle, SandboxProcessManager } from "@mastra/core/workspace";

import { AstroProcessManager, AstroSandbox } from "./astro-sandbox";

const SERVER = "https://app.astropods.com";

function deployToken(): string {
  const encode = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return [encode({ alg: "HS256" }), encode({ sub: "dep-1", iss: SERVER }), "sig"].join(".");
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const record = (over: Record<string, unknown> = {}) =>
  json({
    name: "thread-1",
    class: "default",
    state: "running",
    created_at: "2026-09-16T10:00:00Z",
    last_active_at: "2026-09-16T10:05:00Z",
    ceiling_at: "2026-09-16T18:00:00Z",
    ...over,
  });

const attached = () =>
  json({
    name: "thread-1",
    class: "default",
    state: "running",
    endpoint: "sb.example",
    headers: { "X-aws-proxy-auth": "jwe", "X-aws-proxy-port": "49983", "X-Access-Token": "envd" },
    expires_at: "2026-09-16T12:00:00Z",
  });

const notFound = () => json({ error: "sandbox not found" }, 404);

interface Call {
  url: string;
  method: string;
  body?: string;
}

function harness(handlers: Array<(call: Call) => Response>) {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body as string | undefined,
    };
    calls.push(call);
    return handlers[Math.min(i++, handlers.length - 1)]!(call);
  }) as unknown as typeof fetch;

  const client = new SandboxClient({ identityToken: deployToken(), fetchImpl });
  return { calls, sandbox: new AstroSandbox({ name: "thread-1", client }) };
}

describe("AstroSandbox as a Mastra provider", () => {
  test("is a MastraSandbox, so a workspace accepts it", () => {
    const { sandbox } = harness([attached]);

    expect(sandbox).toBeInstanceOf(MastraSandbox);
    expect(sandbox.processes).toBeInstanceOf(SandboxProcessManager);
    expect(sandbox.provider).toBe("astropods");
    expect(sandbox.id).toBe("thread-1");
  });

  test("the name is the sandbox, so a thread id maps with no table", () => {
    const { sandbox } = harness([attached]);
    expect(sandbox.name).toBe("thread-1");
  });

  test("a first start reports created, a later one reports connected", async () => {
    const first = harness([notFound, attached]);
    await expect(first.sandbox.start()).resolves.toEqual({ outcome: "created" });
    expect(first.sandbox.status).toBe("running");

    const again = harness([record, attached]);
    await expect(again.sandbox.start()).resolves.toEqual({ outcome: "connected" });
  });

  test("a failed start leaves the status at error rather than running", async () => {
    const { sandbox } = harness([notFound, () => json({ error: "no capacity" }, 502)]);

    await expect(sandbox.start()).rejects.toThrow();
    expect(sandbox.status).toBe("error");
  });

  test("executeCommand runs through exec and reports success", async () => {
    const { calls, sandbox } = harness([
      attached,
      () => json({ exit_code: 0, stdout: "hi\n", stderr: "", duration_ms: 9 }),
    ]);

    const result = await sandbox.executeCommand("echo", ["hi"]);

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hi\n");
    expect(result.executionTimeMs).toBe(9);
    expect(calls[1]!.url).toBe("https://sb.example/v1/exec");
  });

  test("a non-zero exit is a result with success false, not a throw", async () => {
    const { sandbox } = harness([
      attached,
      () => json({ exit_code: 3, stdout: "", stderr: "boom", duration_ms: 2 }),
    ]);

    const result = await sandbox.executeCommand("false");

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(3);
  });

  test("output callbacks switch exec to a process, because exec cannot stream", async () => {
    const chunks: string[] = [];
    const { calls, sandbox } = harness([
      attached,
      () => json({ process_id: "p1", state: "running", command: ["x"], started_at: "t" }, 201),
      () =>
        json({
          process_id: "p1",
          state: "running",
          command: ["x"],
          started_at: "t",
          stdout: "step 1\n",
          stderr: "",
          stdout_next: 7,
          stderr_next: 0,
        }),
      () =>
        json({
          process_id: "p1",
          state: "exited",
          exit_code: 0,
          command: ["x"],
          started_at: "t",
          stdout: "step 2\n",
          stderr: "",
          stdout_next: 14,
          stderr_next: 0,
        }),
      () => new Response(null, { status: 204 }),
    ]);

    const result = await sandbox.executeCommand("build", [], {
      onStdout: (data) => chunks.push(data),
    });

    expect(chunks).toEqual(["step 1\n", "step 2\n"]);
    expect(result.stdout).toBe("step 1\nstep 2\n");
    expect(calls.some((c) => c.url.endsWith("/v1/processes"))).toBe(true);
    expect(calls.some((c) => c.url.endsWith("/v1/exec"))).toBe(false);
  });

  test("stop suspends and destroy deletes, each moving the status", async () => {
    const { calls, sandbox } = harness([attached, () => new Response(null, { status: 204 })]);

    await sandbox.stop();
    expect(sandbox.status).toBe("stopped");
    expect(calls[0]!.url).toBe(`${SERVER}/api/v1/sandboxes/thread-1/stop`);

    await sandbox.destroy();
    expect(sandbox.status).toBe("destroyed");
  });

  test("snapshot suspends, and says it cannot address a checkpoint", async () => {
    const { calls, sandbox } = harness([() => new Response(null, { status: 204 })]);

    expect(sandbox.supportsCheckpoints).toBe(false);
    await sandbox.snapshot();

    expect(calls[0]!.url).toContain("/stop");
  });

  test("getInfo carries the ceiling through as the timeout", async () => {
    const { sandbox } = harness([record]);

    const info = await sandbox.getInfo();

    expect(info.provider).toBe("astropods");
    expect(info.createdAt.toISOString()).toBe("2026-09-16T10:00:00.000Z");
    expect(info.timeoutAt?.toISOString()).toBe("2026-09-16T18:00:00.000Z");
  });

  test("writeFiles accepts a Buffer as well as a string", async () => {
    const { calls, sandbox } = harness([
      attached,
      () => json({ exit_code: 0, stdout: "", stderr: "", duration_ms: 1 }),
    ]);

    await sandbox.writeFiles([{ path: "/workspace/a.txt", content: Buffer.from("bytes") }]);

    const command = JSON.parse(calls[1]!.body!).command as string[];
    expect(command[2]).toContain(Buffer.from("bytes").toString("base64"));
  });
});

describe("AstroProcessManager", () => {
  test("spawn returns a handle whose pid is the sandbox's process id", async () => {
    const { sandbox } = harness([
      attached,
      () => json({ process_id: "p7", state: "running", command: ["x"], started_at: "t" }, 201),
    ]);

    const handle = await sandbox.processes.spawn("sleep 30");

    expect(handle).toBeInstanceOf(ProcessHandle);
    expect(handle.pid).toBe("p7");
    expect(handle.exitCode).toBeUndefined();
  });

  test("list reports running and exited processes in Mastra's shape", async () => {
    const { sandbox } = harness([
      attached,
      () =>
        json({
          processes: [
            { process_id: "p1", command: ["sh", "-c", "a"], state: "running", started_at: "t" },
            {
              process_id: "p2",
              command: ["sh", "-c", "b"],
              state: "exited",
              exit_code: 2,
              started_at: "t",
            },
          ],
        }),
    ]);

    const list = await sandbox.processes.list();

    expect(list).toEqual([
      { pid: "p1", command: "sh -c a", running: true, exitCode: undefined },
      { pid: "p2", command: "sh -c b", running: false, exitCode: 2 },
    ]);
  });

  test("wait polls to exit and returns a CommandResult", async () => {
    const { sandbox } = harness([
      attached,
      () => json({ process_id: "p1", state: "running", command: ["x"], started_at: "t" }, 201),
      () =>
        json({
          process_id: "p1",
          state: "exited",
          exit_code: 0,
          command: ["x"],
          started_at: "t",
          stdout: "done\n",
          stderr: "",
          stdout_next: 5,
          stderr_next: 0,
        }),
    ]);

    const handle = await sandbox.processes.spawn("build");
    const result = await handle.wait();

    expect(result.exitCode).toBe(0);
    expect(result.success).toBe(true);
    expect(result.stdout).toBe("done\n");
    expect(handle.exitCode).toBe(0);
  });

  test("kill on an unknown pid answers false rather than throwing", async () => {
    // kill goes through the base's ensureRunning first, so the sequence is
    // get, attach, then the poll that finds no such process.
    const { sandbox } = harness([record, attached, notFound]);

    await expect(sandbox.processes.kill("nope")).resolves.toBe(false);
  });

  test("stdin fails loudly, because the data plane has none", async () => {
    const { sandbox } = harness([
      attached,
      () => json({ process_id: "p1", state: "running", command: ["x"], started_at: "t" }, 201),
    ]);

    const handle = await sandbox.processes.spawn("cat");

    await expect(handle.sendStdin("input")).rejects.toThrow(/no stdin/);
  });
});

describe("the provider names no transport header", () => {
  test("credentials stay opaque from the client through the provider", async () => {
    const source = await Bun.file(
      new URL("./astro-sandbox.ts", import.meta.url).pathname,
    ).text();

    expect(source).not.toContain("X-aws-proxy");
    expect(source).not.toContain("X-Access-Token");
  });
});
