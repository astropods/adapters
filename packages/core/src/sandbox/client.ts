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
    const body = JSON.stringify({
      command: request.command,
      cwd: request.cwd,
      env: request.env,
      timeout_ms: request.timeoutMs,
    });

    let res: Response;
    try {
      res = await this.fetchImpl(`${handle.endpoint}/v1/exec`, {
        method: "POST",
        headers: { ...handle.headers, "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new SandboxUnavailableError(err);
    }

    if (!res.ok) {
      throw new SandboxRequestError(res.status, await errorMessage(res, "exec failed"));
    }
    const out = (await res.json()) as Record<string, unknown>;
    return {
      exitCode: Number(out.exit_code ?? 0),
      stdout: String(out.stdout ?? ""),
      stderr: String(out.stderr ?? ""),
      durationMs: Number(out.duration_ms ?? 0),
      timedOut: out.timed_out === true,
      truncated: out.truncated === true,
    };
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
