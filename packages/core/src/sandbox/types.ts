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

/** A process the sandbox is running, or has finished running. */
export interface ProcessStatus {
  processId: string;
  command: string[];
  state: "running" | "exited";
  /** Absent while the process runs, which is how you tell the two apart. */
  exitCode?: number;
  startedAt: string;
  exitedAt?: string;
}

/**
 * A poll of a process: its status, plus the output after the offsets you
 * asked from.
 */
export interface ProcessOutput extends ProcessStatus {
  stdout: string;
  stderr: string;
  /** Pass these back on the next poll to continue where this one stopped. */
  stdoutNext: number;
  stderrNext: number;
  /**
   * Bytes the sandbox discarded before this read, because output outran the
   * retention window. Non-zero means output was lost, not delayed.
   */
  stdoutDropped: number;
  stderrDropped: number;
}

export interface SpawnRequest {
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface PollOptions {
  stdoutFrom?: number;
  stderrFrom?: number;
}

export type Signal = "TERM" | "KILL" | "INT" | "HUP" | "QUIT" | "USR1" | "USR2";

/** One entry from a directory listing. */
export interface DirEntry {
  name: string;
  isDirectory: boolean;
}

/** One match from a search. */
export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

export interface RunOptions {
  intervalMs?: number;
  onOutput?: (chunk: ProcessOutput) => void;
  /** Kills the process and returns once this elapses. */
  timeoutMs?: number;
  /** Kills the process and returns when this aborts. */
  signal?: AbortSignal;
}

export interface RunResult extends ProcessOutput {
  timedOut: boolean;
  /** The process was stopped by a timeout or an abort rather than exiting. */
  killed: boolean;
}

export interface SandboxOptions {
  /** Raw ASTRO_AUTHZ_TOKEN. Read from the environment when absent. */
  identityToken?: string;
  /** Overrides the server URL the token's issuer claim carries. */
  serverUrl?: string;
  /** Per-request timeout, seconds. */
  timeoutSeconds?: number;
  /** How long `attach` keeps retrying a sandbox the server is still preparing, seconds. */
  prepareTimeoutSeconds?: number;
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

/** The server was still preparing the sandbox when `prepareTimeoutSeconds` ran out. */
export class SandboxPreparingError extends Error {
  constructor(readonly retryAfterMs: number) {
    super("the sandbox is still being prepared");
    this.name = "SandboxPreparingError";
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
