import { decodeDeployToken } from "../auth/token.js";
import {
  SandboxNotEnabledError,
  SandboxRequestError,
  SandboxUnavailableError,
  type ExecRequest,
  type ExecResult,
  type SandboxHandle,
  type SandboxOptions,
  type SandboxRecord,
  type ProcessStatus,
  type ProcessOutput,
  type SpawnRequest,
  type PollOptions,
  type Signal,
  type DirEntry,
  type GrepMatch,
} from "./types.js";

const DEFAULT_TIMEOUT_SECONDS = 30;

/**
 * Attaches sandboxes for one deployment and runs commands in them.
 *
 * The transport is deliberately not part of the surface. Callers see
 * `attach` and `exec`; the endpoint, the two credentials and their refresh
 * stay in here, so replacing the wire format later changes this file and no
 * agent code.
 */
export class SandboxClient {
  private readonly serverUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly handles = new Map<string, SandboxHandle>();

  constructor(options: SandboxOptions = {}) {
    this.token = options.identityToken ?? process.env.ASTRO_AUTHZ_TOKEN ?? "";
    const claims = decodeDeployToken(this.token);
    this.serverUrl = (options.serverUrl ?? claims.issuer).replace(/\/+$/, "");
    this.timeoutMs = (options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Resolves a name to a usable sandbox, creating one on the first call and
   * reusing it after. Safe to call on every turn: the server settles
   * concurrent first calls on one sandbox.
   */
  async attach(name: string, sandboxClass?: string): Promise<SandboxHandle> {
    const body = sandboxClass ? JSON.stringify({ class: sandboxClass }) : undefined;
    const handle = await this.request<Record<string, unknown>>(
      "PUT",
      `/api/v1/sandboxes/${encodeURIComponent(name)}`,
      body,
    );
    const resolved: SandboxHandle = {
      name: String(handle.name ?? name),
      class: String(handle.class ?? ""),
      state: String(handle.state ?? ""),
      endpoint: withScheme(String(handle.endpoint ?? "")),
      headers: (handle.headers as Record<string, string>) ?? {},
      expiresAt: String(handle.expires_at ?? ""),
    };
    this.handles.set(name, resolved);
    return resolved;
  }

  /**
   * Runs a command in the sandbox for `name`, attaching first if needed.
   *
   * Re-attaches once when the sandbox refuses the credentials or the endpoint
   * has moved, because both happen for ordinary reasons: credentials are
   * short-lived, and a sandbox past its duration ceiling is replaced.
   */
  async exec(name: string, request: ExecRequest): Promise<ExecResult> {
    let handle = this.handles.get(name) ?? (await this.attach(name));
    try {
      return await this.execOn(handle, request);
    } catch (err) {
      if (!isStaleHandle(err)) throw err;
      this.handles.delete(name);
      handle = await this.attach(name);
      return await this.execOn(handle, request);
    }
  }

  async get(name: string): Promise<SandboxRecord> {
    const row = await this.request<Record<string, unknown>>(
      "GET",
      `/api/v1/sandboxes/${encodeURIComponent(name)}`,
    );
    return toRecord(row);
  }

  async list(): Promise<SandboxRecord[]> {
    const body = await this.request<{ sandboxes?: Record<string, unknown>[] }>(
      "GET",
      "/api/v1/sandboxes",
    );
    return (body.sandboxes ?? []).map(toRecord);
  }

  /**
   * Starts a command and returns before it finishes. Use this for anything
   * slow: `exec` buffers output until exit and truncates it, while a spawned
   * process is drained incrementally by `poll`.
   */
  async spawn(name: string, request: SpawnRequest): Promise<ProcessStatus> {
    const row = await this.dataPlane<Record<string, unknown>>(name, "POST", "/v1/processes", {
      command: request.command,
      cwd: request.cwd,
      env: request.env,
    });
    return toStatus(row);
  }

  /**
   * Reads a process's status and whatever it has written since the offsets
   * given. Pass the previous result's `stdoutNext` and `stderrNext` to
   * continue without repeating or skipping.
   */
  async poll(name: string, processId: string, options: PollOptions = {}): Promise<ProcessOutput> {
    const query = new URLSearchParams();
    if (options.stdoutFrom) query.set("stdout_from", String(options.stdoutFrom));
    if (options.stderrFrom) query.set("stderr_from", String(options.stderrFrom));
    const suffix = query.size > 0 ? `?${query.toString()}` : "";

    const row = await this.dataPlane<Record<string, unknown>>(
      name,
      "GET",
      `/v1/processes/${encodeURIComponent(processId)}${suffix}`,
    );
    return {
      ...toStatus(row),
      stdout: String(row.stdout ?? ""),
      stderr: String(row.stderr ?? ""),
      stdoutNext: Number(row.stdout_next ?? 0),
      stderrNext: Number(row.stderr_next ?? 0),
      stdoutDropped: Number(row.stdout_dropped ?? 0),
      stderrDropped: Number(row.stderr_dropped ?? 0),
    };
  }

  async processes(name: string): Promise<ProcessStatus[]> {
    const body = await this.dataPlane<{ processes?: Record<string, unknown>[] }>(
      name,
      "GET",
      "/v1/processes",
    );
    return (body.processes ?? []).map(toStatus);
  }

  /** Signals the process group, so a shell's children get it too. */
  async signal(name: string, processId: string, signal: Signal = "TERM"): Promise<void> {
    await this.dataPlane<void>(
      name,
      "POST",
      `/v1/processes/${encodeURIComponent(processId)}/signal`,
      { signal },
    );
  }

  /** Kills the process if it is still running, then forgets it. */
  async kill(name: string, processId: string): Promise<void> {
    await this.dataPlane<void>(
      name,
      "DELETE",
      `/v1/processes/${encodeURIComponent(processId)}`,
    );
  }

  /**
   * Runs a command to completion and resolves once it exits, draining output
   * as it goes. Unlike `exec` this neither buffers to a cap nor holds a
   * request open, so it suits an install or a build.
   */
  async run(
    name: string,
    request: SpawnRequest,
    options: { intervalMs?: number; onOutput?: (chunk: ProcessOutput) => void } = {},
  ): Promise<ProcessOutput> {
    const interval = options.intervalMs ?? 500;
    const started = await this.spawn(name, request);
    let stdoutFrom = 0;
    let stderrFrom = 0;
    let stdout = "";
    let stderr = "";

    for (;;) {
      const chunk = await this.poll(name, started.processId, { stdoutFrom, stderrFrom });
      stdout += chunk.stdout;
      stderr += chunk.stderr;
      stdoutFrom = chunk.stdoutNext;
      stderrFrom = chunk.stderrNext;
      if (chunk.stdout || chunk.stderr) options.onOutput?.(chunk);
      if (chunk.state === "exited") {
        await this.kill(name, started.processId).catch(() => {});
        return { ...chunk, stdout, stderr };
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }

  /** Reads a file, base64 on the wire so binary and newlines survive. */
  async readFile(name: string, path: string): Promise<string> {
    const result = await this.exec(name, {
      command: ["/bin/sh", "-c", `base64 < ${sq(path)}`],
    });
    if (result.exitCode !== 0) {
      throw new SandboxRequestError(404, `could not read ${path}: ${result.stderr.trim()}`);
    }
    return Buffer.from(result.stdout.replace(/\s/g, ""), "base64").toString("utf8");
  }

  async writeFile(name: string, path: string, contents: string): Promise<void> {
    const encoded = Buffer.from(contents, "utf8").toString("base64");
    const result = await this.exec(name, {
      command: ["/bin/sh", "-c", `printf %s ${sq(encoded)} | base64 -d > ${sq(path)}`],
    });
    if (result.exitCode !== 0) {
      throw new SandboxRequestError(400, `could not write ${path}: ${result.stderr.trim()}`);
    }
  }

  async listDir(name: string, path = "."): Promise<DirEntry[]> {
    const result = await this.exec(name, {
      command: ["/bin/sh", "-c", `ls -1Ap ${sq(path)}`],
    });
    if (result.exitCode !== 0) {
      throw new SandboxRequestError(404, `could not list ${path}: ${result.stderr.trim()}`);
    }
    return result.stdout
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => ({
        name: line.endsWith("/") ? line.slice(0, -1) : line,
        isDirectory: line.endsWith("/"),
      }));
  }

  /**
   * Searches file contents. An empty result is not an error: grep exits 1
   * when nothing matches, which is a normal answer to a search.
   */
  async grep(name: string, pattern: string, path = "."): Promise<GrepMatch[]> {
    const result = await this.exec(name, {
      command: ["/bin/sh", "-c", `grep -rnI -e ${sq(pattern)} ${sq(path)}`],
    });
    if (result.exitCode > 1) {
      throw new SandboxRequestError(400, `could not search ${path}: ${result.stderr.trim()}`);
    }
    return result.stdout
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => {
        const [file, lineNo, ...rest] = line.split(":");
        return {
          path: file ?? "",
          line: Number(lineNo ?? 0),
          text: rest.join(":"),
        };
      })
      .filter((match) => Number.isFinite(match.line) && match.line > 0);
  }

  /** Stops compute early. Optional: an idle sandbox sleeps on its own. */
  async stop(name: string): Promise<void> {
    await this.request<void>(
      "POST",
      `/api/v1/sandboxes/${encodeURIComponent(name)}/stop`,
    );
    this.handles.delete(name);
  }

  /** Drops the sandbox and everything it held. */
  async delete(name: string): Promise<void> {
    await this.request<void>(
      "DELETE",
      `/api/v1/sandboxes/${encodeURIComponent(name)}`,
    );
    this.handles.delete(name);
  }

  private async execOn(handle: SandboxHandle, request: ExecRequest): Promise<ExecResult> {
    const out = await this.dataPlaneOn<Record<string, unknown>>(
      handle,
      "POST",
      "/v1/exec",
      {
        command: request.command,
        cwd: request.cwd,
        env: request.env,
        timeout_ms: request.timeoutMs,
      },
      "exec failed",
    );
    return {
      exitCode: Number(out.exit_code ?? 0),
      stdout: String(out.stdout ?? ""),
      stderr: String(out.stderr ?? ""),
      durationMs: Number(out.duration_ms ?? 0),
      timedOut: out.timed_out === true,
      truncated: out.truncated === true,
    };
  }

  /**
   * Every data-plane call goes through here so the stale-handle retry is
   * written once. Credentials are short-lived and a sandbox past its ceiling
   * is replaced, so one re-attach is ordinary rather than fatal.
   */
  private async dataPlane<T>(
    name: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    let handle = this.handles.get(name) ?? (await this.attach(name));
    try {
      return await this.dataPlaneOn<T>(handle, method, path, body);
    } catch (err) {
      if (!isStaleHandle(err)) throw err;
      this.handles.delete(name);
      handle = await this.attach(name);
      return await this.dataPlaneOn<T>(handle, method, path, body);
    }
  }

  private async dataPlaneOn<T>(
    handle: SandboxHandle,
    method: string,
    path: string,
    body?: unknown,
    fallback = "sandbox request failed",
  ): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${handle.endpoint}${path}`, {
        method,
        headers:
          body === undefined
            ? { ...handle.headers }
            : { ...handle.headers, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new SandboxUnavailableError(err);
    }

    if (!res.ok) {
      throw new SandboxRequestError(res.status, await errorMessage(res, fallback));
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private async request<T>(method: string, path: string, body?: string): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.serverUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new SandboxUnavailableError(err);
    }

    if (res.status === 409) {
      throw new SandboxNotEnabledError(await errorMessage(res, "sandboxes are not enabled"));
    }
    if (!res.ok) {
      throw new SandboxRequestError(res.status, await errorMessage(res, `${method} ${path} failed`));
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
}

/**
 * RunMicrovm returns a bare hostname, and the control plane passes it through,
 * so every caller would otherwise have to add this.
 */
function withScheme(endpoint: string): string {
  if (!endpoint) return endpoint;
  return /^https?:\/\//.test(endpoint) ? endpoint : `https://${endpoint}`;
}

function isStaleHandle(err: unknown): boolean {
  if (err instanceof SandboxUnavailableError) return true;
  return err instanceof SandboxRequestError && (err.status === 401 || err.status === 403);
}

function toRecord(row: Record<string, unknown>): SandboxRecord {
  return {
    name: String(row.name ?? ""),
    class: String(row.class ?? ""),
    state: String(row.state ?? ""),
    createdAt: String(row.created_at ?? ""),
    lastActiveAt: String(row.last_active_at ?? ""),
    ceilingAt: row.ceiling_at ? String(row.ceiling_at) : undefined,
  };
}

/**
 * Anything between the agent and the control plane can answer instead of it,
 * and a CDN or proxy body is not JSON, so the raw body has to survive into the
 * message. Without it the caller only learns that the call failed.
 */
async function errorMessage(res: Response, fallback: string): Promise<string> {
  const raw = await res.text().catch(() => "");
  if (!raw) return fallback;
  try {
    const body = JSON.parse(raw) as { error?: string };
    if (typeof body.error === "string") return body.error;
  } catch {
    // Not JSON. Fall through to the raw body.
  }
  return `${fallback}: ${raw.replace(/\s+/g, " ").trim().slice(0, 200)}`;
}

/**
 * Quotes a path for `sh -c`. Single quotes are literal in POSIX shells, so
 * only an embedded single quote needs work.
 */
function sq(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function toStatus(row: Record<string, unknown>): ProcessStatus {
  return {
    processId: String(row.process_id ?? ""),
    command: (row.command as string[]) ?? [],
    state: row.state === "exited" ? "exited" : "running",
    exitCode: typeof row.exit_code === "number" ? row.exit_code : undefined,
    startedAt: String(row.started_at ?? ""),
    exitedAt: row.exited_at ? String(row.exited_at) : undefined,
  };
}
