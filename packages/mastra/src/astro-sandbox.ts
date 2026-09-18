import {
  MastraSandbox,
  ProcessHandle,
  SandboxProcessManager,
  type CommandResult,
  type ExecuteCommandOptions,
  type ProcessInfo,
  type ProviderStatus,
  type SandboxFileInput,
  type SandboxInfo,
  type SandboxStartResult,
  type SpawnProcessOptions,
} from "@mastra/core/workspace";
import {
  SandboxClient,
  SandboxRequestError,
  type ProcessOutput,
  type SandboxOptions,
} from "@astropods/adapter-core";

export interface AstroSandboxOptions extends SandboxOptions {
  /**
   * Names the sandbox. Use the thread id: one thread is one sandbox, so a
   * conversation that resumes reattaches to its own files and two threads
   * never share a filesystem.
   */
  name: string;
  /** Reuse a client instead of constructing one. */
  client?: SandboxClient;
}

const PROVIDER = "astropods";

/**
 * An Astro sandbox as a Mastra sandbox provider, so Mastra's own workspace
 * drives it: its filesystem, its mounts and its built-in tools all run
 * against the MicroVM instead of against a parallel toolset.
 *
 * Attach does the work of find, connect and create at once, which is why the
 * lifecycle here is thin: `PUT /api/v1/sandboxes/{name}` creates on the first
 * call, reuses a running sandbox, and resumes a suspended one.
 */
export class AstroSandbox extends MastraSandbox {
  readonly id: string;
  readonly name: string;
  readonly provider = PROVIDER;
  status: ProviderStatus = "pending";

  /**
   * False because a checkpoint here is not addressable. Suspending snapshots
   * the MicroVM's memory and the next attach resumes it, but there is only
   * ever the latest state to go back to. Persistence past the 8 hour ceiling
   * is not built.
   */
  readonly supportsCheckpoints = false;

  readonly processes: AstroProcessManager;

  private readonly client: SandboxClient;
  private createdAt?: Date;

  constructor(options: AstroSandboxOptions) {
    const { name, client, ...clientOptions } = options;
    super({ name });
    this.id = name;
    this.name = name;
    this.client = client ?? new SandboxClient(clientOptions);
    this.processes = new AstroProcessManager(this.client, name);
    // The base wraps spawn/kill to call sandbox.ensureRunning() first, so the
    // manager has to know which sandbox it belongs to. Mastra then starts the
    // sandbox on demand and nothing here has to.
    this.processes.sandbox = this;
  }

  /**
   * Always reports `created`, because the control plane does not say whether
   * an attach launched a VM or resumed one, and a sandbox row outlives the VM
   * it points at: a row can exist while the next attach launches something
   * fresh. Mastra branches on this to skip once-per-VM setup, so over-
   * reporting `created` repeats setup while under-reporting would skip it on a
   * genuinely new machine.
   */
  override async start(): Promise<SandboxStartResult> {
    this.status = "starting";
    try {
      await this.client.attach(this.name);
    } catch (err) {
      this.status = "error";
      throw err;
    }
    this.status = "running";
    this.createdAt ??= new Date();
    return { outcome: "created" };
  }

  override async stop(): Promise<void> {
    await this.client.stop(this.name);
    this.status = "stopped";
  }

  override async destroy(): Promise<void> {
    await this.client.delete(this.name);
    this.status = "destroyed";
  }

  /**
   * Suspends, which is the only checkpoint the platform takes: the MicroVM's
   * memory is snapshotted and the next attach resumes from it. Nothing is
   * written anywhere a later session could address, hence
   * `supportsCheckpoints: false`.
   */
  async snapshot(): Promise<void> {
    await this.stop();
  }

  async isReady(): Promise<boolean> {
    return this.status === "running";
  }

  override async getInfo(): Promise<SandboxInfo> {
    const record = await this.client.get(this.name);
    return {
      id: this.id,
      name: this.name,
      provider: PROVIDER,
      status: this.status,
      createdAt: new Date(record.createdAt),
      lastUsedAt: record.lastActiveAt ? new Date(record.lastActiveAt) : undefined,
      timeoutAt: record.ceilingAt ? new Date(record.ceilingAt) : undefined,
    };
  }

  getInstructions(): string {
    return (
      `You have a sandbox: an isolated Linux machine, separate from any other ` +
      `conversation's. Files you write persist for this conversation. Long ` +
      `work belongs in a background process so its output streams as it runs, ` +
      `rather than arriving all at once when it finishes.`
    );
  }

  override async executeCommand(
    command: string,
    args: string[] = [],
    options: ExecuteCommandOptions = {},
  ): Promise<CommandResult> {
    const line = [command, ...args].join(" ");
    const request = {
      command: ["/bin/sh", "-c", line],
      cwd: options.cwd,
      env: stringEnv(options.env),
    };

    const started = Date.now();

    // Callbacks mean the caller wants output as it appears, which exec cannot
    // do: it buffers to exit. Route those through a process instead.
    if (options.onStdout || options.onStderr) {
      const result = await this.client.run(this.name, request, {
        timeoutMs: options.timeout,
        signal: options.abortSignal,
        onOutput: (chunk) => {
          if (chunk.stdout) options.onStdout?.(chunk.stdout);
          if (chunk.stderr) options.onStderr?.(chunk.stderr);
        },
      });
      return {
        command,
        args,
        success: !result.killed && result.exitCode === 0,
        exitCode: result.exitCode ?? -1,
        stdout: result.stdout,
        stderr: result.stderr,
        executionTimeMs: Date.now() - started,
        timedOut: result.timedOut,
        killed: result.killed,
      };
    }

    const result = await this.client.exec(this.name, {
      ...request,
      timeoutMs: options.timeout,
    });
    return {
      command,
      args,
      success: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      executionTimeMs: result.durationMs,
      timedOut: result.timedOut,
    };
  }

  override async writeFiles(files: SandboxFileInput[]): Promise<void> {
    for (const file of files) {
      if (typeof file.content === "string") {
        await this.client.writeFile(this.name, file.path, file.content);
      } else {
        await this.client.writeFileBytes(this.name, file.path, file.content);
      }
    }
  }
}

/** Mastra's process manager, backed by the sandbox's own process API. */
export class AstroProcessManager extends SandboxProcessManager {
  constructor(
    private readonly client: SandboxClient,
    private readonly sandboxName: string,
  ) {
    super();
  }

  override async spawn(
    command: string,
    options: SpawnProcessOptions = {},
  ): Promise<ProcessHandle> {
    const started = await this.client.spawn(this.sandboxName, {
      command: ["/bin/sh", "-c", command],
      cwd: options.cwd,
      env: stringEnv(options.env),
    });
    const handle = new AstroProcessHandle(
      this.client,
      this.sandboxName,
      started.processId,
      command,
      options,
    );
    this._tracked.set(started.processId, handle);
    return handle;
  }

  override async list(): Promise<ProcessInfo[]> {
    const rows = await this.client.processes(this.sandboxName);
    return rows.map((row) => ({
      pid: row.processId,
      command: row.command.join(" "),
      running: row.state === "running",
      exitCode: row.exitCode,
    }));
  }

  override async get(pid: string): Promise<ProcessHandle | undefined> {
    const tracked = this._tracked.get(pid);
    if (tracked) return tracked;
    try {
      const out = await this.client.poll(this.sandboxName, pid);
      return new AstroProcessHandle(
        this.client,
        this.sandboxName,
        pid,
        out.command.join(" "),
      );
    } catch {
      return undefined;
    }
  }

  override async kill(pid: string): Promise<boolean> {
    const handle = await this.get(pid);
    if (!handle) return false;
    this._tracked.delete(pid);
    return handle.kill();
  }
}

class AstroProcessHandle extends ProcessHandle {
  readonly pid: string;
  private lastExitCode: number | undefined;
  private stdoutFrom = 0;
  private stderrFrom = 0;

  constructor(
    private readonly client: SandboxClient,
    private readonly sandboxName: string,
    pid: string,
    command: string,
    options?: Pick<SpawnProcessOptions, "maxRetainedBytes" | "onStdout" | "onStderr">,
  ) {
    super(options);
    this.pid = pid;
    this.command = command;
  }

  get exitCode(): number | undefined {
    return this.lastExitCode;
  }

  override async kill(): Promise<boolean> {
    try {
      await this.client.kill(this.sandboxName, this.pid);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The data plane has no stdin: a command is spawned with what it needs or
   * reads a file. Failing loudly is better than accepting the write and
   * dropping it.
   */
  override async sendStdin(_data: string): Promise<void> {
    throw new Error(
      "an Astro sandbox process has no stdin; pass input through the command or a file",
    );
  }

  /**
   * Takes no arguments: the base constructor replaces `wait` with a wrapper
   * that registers the caller's callbacks, handles `abortSignal` by killing,
   * and then calls this with none. Output reaches every listener and the
   * retained buffers only through `emitStdout`/`emitStderr`.
   */
  override async wait(): Promise<CommandResult> {
    const started = Date.now();

    for (;;) {
      let out: ProcessOutput;
      try {
        out = await this.client.poll(this.sandboxName, this.pid, {
          stdoutFrom: this.stdoutFrom,
          stderrFrom: this.stderrFrom,
        });
      } catch (err) {
        // The wrapper's abort handler kills the process, and a killed process
        // is deleted, so a 404 here means this wait was cancelled rather than
        // that the process never existed.
        if (err instanceof SandboxRequestError && err.status === 404) {
          return this.result(started, this.lastExitCode ?? -1, true);
        }
        throw err;
      }

      this.stdoutFrom = out.stdoutNext;
      this.stderrFrom = out.stderrNext;
      if (out.stdout) this.emitStdout(out.stdout);
      if (out.stderr) this.emitStderr(out.stderr);

      if (out.state === "exited") {
        this.lastExitCode = out.exitCode ?? 0;
        return this.result(started, this.lastExitCode, false);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  private result(started: number, exitCode: number, killed: boolean): CommandResult {
    return {
      command: this.command,
      success: !killed && exitCode === 0,
      exitCode,
      stdout: this.stdout,
      stderr: this.stderr,
      executionTimeMs: Date.now() - started,
      killed,
    };
  }
}

/** Mastra passes a NodeJS.ProcessEnv, which allows undefined values. */
function stringEnv(env?: NodeJS.ProcessEnv): Record<string, string> | undefined {
  if (!env) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
