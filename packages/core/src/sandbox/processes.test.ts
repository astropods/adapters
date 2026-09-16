import { describe, expect, test } from "bun:test";

import { SandboxClient } from "./client";

const SERVER = "https://app.astropods.com";

function deployToken(): string {
  const encode = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return [
    encode({ alg: "HS256", typ: "JWT" }),
    encode({ sub: "abc-def-ghi", iss: SERVER }),
    "signature",
  ].join(".");
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const attachResponse = () =>
  json({
    name: "conv-1",
    class: "default",
    state: "running",
    endpoint: "sb.example",
    headers: { "X-aws-proxy-auth": "jwe", "X-aws-proxy-port": "49983", "X-Access-Token": "envd" },
    expires_at: "2026-09-17T12:00:00Z",
  });

interface Call {
  url: string;
  method: string;
  body?: string;
}

function stub(handlers: Array<(call: Call) => Response>) {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body as string | undefined,
    });
    return handlers[Math.min(i++, handlers.length - 1)]!(calls[calls.length - 1]!);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const client = (fetchImpl: typeof fetch) =>
  new SandboxClient({ identityToken: deployToken(), fetchImpl });

describe("processes", () => {
  test("spawn returns a handle before the process exits", async () => {
    const { calls, fetchImpl } = stub([
      () => attachResponse(),
      () =>
        json(
          {
            process_id: "p1",
            command: ["/bin/sh", "-c", "sleep 30"],
            state: "running",
            started_at: "2026-09-17T11:00:00Z",
          },
          201,
        ),
    ]);

    const p = await client(fetchImpl).spawn("conv-1", { command: ["/bin/sh", "-c", "sleep 30"] });

    expect(p.processId).toBe("p1");
    expect(p.state).toBe("running");
    expect(p.exitCode).toBeUndefined();
    expect(calls[1]!.url).toBe("https://sb.example/v1/processes");
    expect(calls[1]!.method).toBe("POST");
  });

  test("poll sends the offsets it was given and reports the next ones", async () => {
    const { calls, fetchImpl } = stub([
      () => attachResponse(),
      () =>
        json({
          process_id: "p1",
          state: "running",
          command: ["x"],
          started_at: "t",
          stdout: "more",
          stderr: "",
          stdout_next: 12,
          stderr_next: 0,
          stdout_dropped: 0,
          stderr_dropped: 0,
        }),
    ]);

    const out = await client(fetchImpl).poll("conv-1", "p1", { stdoutFrom: 8 });

    expect(out.stdout).toBe("more");
    expect(out.stdoutNext).toBe(12);
    expect(calls[1]!.url).toBe("https://sb.example/v1/processes/p1?stdout_from=8");
  });

  test("poll surfaces dropped bytes rather than hiding the gap", async () => {
    const { fetchImpl } = stub([
      () => attachResponse(),
      () =>
        json({
          process_id: "p1",
          state: "running",
          command: ["x"],
          started_at: "t",
          stdout: "tail",
          stderr: "",
          stdout_next: 5000,
          stderr_next: 0,
          stdout_dropped: 4096,
          stderr_dropped: 0,
        }),
    ]);

    const out = await client(fetchImpl).poll("conv-1", "p1");

    expect(out.stdoutDropped).toBe(4096);
  });

  test("run drains across polls and resolves with the whole output", async () => {
    const { fetchImpl } = stub([
      () => attachResponse(),
      () => json({ process_id: "p1", state: "running", command: ["x"], started_at: "t" }, 201),
      () =>
        json({
          process_id: "p1",
          state: "running",
          command: ["x"],
          started_at: "t",
          stdout: "first ",
          stderr: "",
          stdout_next: 6,
          stderr_next: 0,
        }),
      () =>
        json({
          process_id: "p1",
          state: "exited",
          exit_code: 0,
          command: ["x"],
          started_at: "t",
          exited_at: "t2",
          stdout: "second",
          stderr: "",
          stdout_next: 12,
          stderr_next: 0,
        }),
      () => new Response(null, { status: 204 }),
    ]);

    const out = await client(fetchImpl).run("conv-1", { command: ["x"] }, { intervalMs: 0 });

    expect(out.stdout).toBe("first second");
    expect(out.state).toBe("exited");
    expect(out.exitCode).toBe(0);
  });

  test("signal defaults to TERM and kill removes the process", async () => {
    const { calls, fetchImpl } = stub([
      () => attachResponse(),
      () => new Response(null, { status: 204 }),
      () => new Response(null, { status: 204 }),
    ]);

    const c = client(fetchImpl);
    await c.signal("conv-1", "p1");
    await c.kill("conv-1", "p1");

    expect(calls[1]!.url).toBe("https://sb.example/v1/processes/p1/signal");
    expect(JSON.parse(calls[1]!.body!)).toEqual({ signal: "TERM" });
    expect(calls[2]!.method).toBe("DELETE");
  });
});

describe("files", () => {
  const execResult = (stdout: string, exitCode = 0) =>
    json({ exit_code: exitCode, stdout, stderr: "", duration_ms: 1 });

  test("readFile decodes what the sandbox base64-encodes", async () => {
    const body = Buffer.from("line one\nline two\n").toString("base64");
    const { calls, fetchImpl } = stub([() => attachResponse(), () => execResult(body)]);

    const out = await client(fetchImpl).readFile("conv-1", "/workspace/a.txt");

    expect(out).toBe("line one\nline two\n");
    expect(calls[1]!.body).toContain("base64 < '/workspace/a.txt'");
  });

  test("readFile quotes a path containing a single quote", async () => {
    const { calls, fetchImpl } = stub([() => attachResponse(), () => execResult("")]);

    await client(fetchImpl).readFile("conv-1", "/workspace/it's.txt");

    // Assert the shell string itself, not its JSON encoding: close, escaped
    // literal quote, reopen. Getting this wrong is a shell injection.
    const command = JSON.parse(calls[1]!.body!).command as string[];
    expect(command[2]).toBe(String.raw`base64 < '/workspace/it'\''s.txt'`);
  });

  test("readFile reports a missing file instead of returning empty", async () => {
    const { fetchImpl } = stub([
      () => attachResponse(),
      () => json({ exit_code: 1, stdout: "", stderr: "No such file", duration_ms: 1 }),
    ]);

    await expect(client(fetchImpl).readFile("conv-1", "/nope")).rejects.toThrow(/could not read/);
  });

  test("listDir separates directories from files", async () => {
    const { fetchImpl } = stub([() => attachResponse(), () => execResult("src/\nREADME.md\n")]);

    const entries = await client(fetchImpl).listDir("conv-1", "/workspace");

    expect(entries).toEqual([
      { name: "src", isDirectory: true },
      { name: "README.md", isDirectory: false },
    ]);
  });

  test("grep parses matches and treats no match as an empty result", async () => {
    const { fetchImpl } = stub([
      () => attachResponse(),
      () => execResult("src/a.ts:12:const x = 1\n"),
    ]);
    const matches = await client(fetchImpl).grep("conv-1", "const", "src");
    expect(matches).toEqual([{ path: "src/a.ts", line: 12, text: "const x = 1" }]);

    const empty = stub([() => attachResponse(), () => execResult("", 1)]);
    await expect(client(empty.fetchImpl).grep("conv-1", "nothing")).resolves.toEqual([]);
  });

  test("grep keeps a colon that belongs to the matched text", async () => {
    const { fetchImpl } = stub([
      () => attachResponse(),
      () => execResult("a.ts:3:const url = https://x\n"),
    ]);

    const matches = await client(fetchImpl).grep("conv-1", "url");

    expect(matches[0]!.text).toBe("const url = https://x");
  });
});
