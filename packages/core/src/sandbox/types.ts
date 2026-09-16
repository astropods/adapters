/** A sandbox as the control plane hands it back, ready to run commands in. */
export interface SandboxHandle {
  name: string;
  class: string;
  state: string;
  /** Absolute base URL for the data plane, scheme included. */
  endpoint: string;
  /**
   * Opaque. Merge every entry into each data-plane request. Which headers
   * appear is a property of the runtime the sandbox landed on, not of this
   * API, so nothing here interprets them.
   */
  headers: Record<string, string>;
  /** When `headers` stop working, RFC 3339. */
  expiresAt: string;
}

/** A sandbox as the control plane records it, with no credentials. */
export interface SandboxRecord {
  name: string;
  class: string;
  state: string;
  createdAt: string;
  lastActiveAt: string;
  /** When the runtime reclaims it regardless of activity. Absent when nothing runs. */
  ceilingAt?: string;
}

export interface ExecRequest {
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** The command was killed at its timeout rather than exiting. */
  timedOut: boolean;
  /** Output was cut at the sandbox's per-stream cap. */
  truncated: boolean;
}

export interface SandboxOptions {
  /** Raw ASTRO_AUTHZ_TOKEN. Read from the environment when absent. */
  identityToken?: string;
  /** Overrides the server URL the token's issuer claim carries. */
  serverUrl?: string;
  /** Per-request timeout, seconds. */
  timeoutSeconds?: number;
  /** Overridable transport, for tests. */
  fetchImpl?: typeof fetch;
}

/** The control plane refused the request, with the status it used. */
export class SandboxRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`${message} (HTTP ${status})`);
    this.name = "SandboxRequestError";
  }
}

/** The control plane could not be reached at all. */
export class SandboxUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`sandbox control plane unreachable: ${String(cause)}`);
    this.name = "SandboxUnavailableError";
    this.cause = cause;
  }
}

/** This account has not enabled sandboxes. */
export class SandboxNotEnabledError extends SandboxRequestError {
  constructor(message: string) {
    super(409, message);
    this.name = "SandboxNotEnabledError";
  }
}
