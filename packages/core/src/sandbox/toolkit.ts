import type { SandboxClient } from "./client.js";

/**
 * The sandbox operations a framework provider exposes, described once.
 *
 * Every provider wraps the same eight, with the same names and the same
 * prose, so an agent behaves the same whichever framework it was written in
 * and a change to a description does not have to be made twice. A provider
 * supplies its own schema types, because each framework wants its own.
 */

export interface ToolSpec {
  name: string;
  description: string;
  /** Argument names in the order a caller supplies them. */
  args: readonly ToolArg[];
  run(client: SandboxClient, sandbox: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface ToolArg {
  name: string;
  description: string;
  type: "string" | "string[]" | "number" | "boolean";
  required: boolean;
}

const str = (name: string, description: string, required = true): ToolArg => ({
  name,
  description,
  type: "string",
  required,
});

const num = (name: string, description: string): ToolArg => ({
  name,
  description,
  type: "number",
  required: false,
});

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export const SANDBOX_TOOLS: readonly ToolSpec[] = [
  {
    name: "sandbox_exec",
    description:
      "Run a short shell command in the sandbox and wait for it to finish. " +
      "Returns the exit code, stdout and stderr. Output is capped, so use " +
      "sandbox_run for anything that installs, builds or downloads.",
    args: [
      str("command", "The command line to run, as a single shell string."),
      str("cwd", "Directory to run in. Defaults to the workspace.", false),
    ],
    async run(client, sandbox, args) {
      const result = await client.exec(sandbox, {
        command: ["/bin/sh", "-c", text(args.command)],
        cwd: text(args.cwd) || undefined,
      });
      return {
        exit_code: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.truncated,
      };
    },
  },
  {
    name: "sandbox_run",
    description:
      "Run a long command in the sandbox and wait for it to finish, without " +
      "the output cap sandbox_exec has. Use this for installs and builds.",
    args: [
      str("command", "The command line to run, as a single shell string."),
      str("cwd", "Directory to run in. Defaults to the workspace.", false),
    ],
    async run(client, sandbox, args) {
      const result = await client.run(sandbox, {
        command: ["/bin/sh", "-c", text(args.command)],
        cwd: text(args.cwd) || undefined,
      });
      return {
        exit_code: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        dropped_bytes: result.stdoutDropped + result.stderrDropped,
      };
    },
  },
  {
    name: "sandbox_read_file",
    description: "Read a file from the sandbox and return its contents as text.",
    args: [str("path", "Path to the file.")],
    async run(client, sandbox, args) {
      return { contents: await client.readFile(sandbox, text(args.path)) };
    },
  },
  {
    name: "sandbox_write_file",
    description: "Write text to a file in the sandbox, replacing it if it exists.",
    args: [str("path", "Path to the file."), str("contents", "Text to write.")],
    async run(client, sandbox, args) {
      await client.writeFile(sandbox, text(args.path), text(args.contents));
      return { written: true };
    },
  },
  {
    name: "sandbox_list_dir",
    description:
      "List a directory in the sandbox. Each entry says whether it is a directory.",
    args: [str("path", "Directory to list. Defaults to the workspace.", false)],
    async run(client, sandbox, args) {
      return { entries: await client.listDir(sandbox, text(args.path) || ".") };
    },
  },
  {
    name: "sandbox_grep",
    description:
      "Search file contents in the sandbox and return the matching lines with " +
      "their file and line number. No match is an empty result, not an error.",
    args: [
      str("pattern", "Text or basic regular expression to search for."),
      str("path", "File or directory to search. Defaults to the workspace.", false),
    ],
    async run(client, sandbox, args) {
      return {
        matches: await client.grep(sandbox, text(args.pattern), text(args.path) || "."),
      };
    },
  },
  {
    name: "sandbox_spawn",
    description:
      "Start a command in the background and return a process id immediately. " +
      "Read its output with sandbox_poll and stop it with sandbox_kill. Use " +
      "this for a server or a watcher that should keep running.",
    args: [
      str("command", "The command line to run, as a single shell string."),
      str("cwd", "Directory to run in. Defaults to the workspace.", false),
    ],
    async run(client, sandbox, args) {
      const started = await client.spawn(sandbox, {
        command: ["/bin/sh", "-c", text(args.command)],
        cwd: text(args.cwd) || undefined,
      });
      return { process_id: started.processId, state: started.state };
    },
  },
  {
    name: "sandbox_poll",
    description:
      "Read a background process's status and any output since you last read " +
      "it. Pass the stdout_next value from the previous call as stdout_from to " +
      "continue where you stopped. state is 'running' or 'exited'.",
    args: [
      str("process_id", "The id sandbox_spawn returned."),
      num("stdout_from", "Byte offset to read stdout from. Use the previous stdout_next."),
      num("stderr_from", "Byte offset to read stderr from. Use the previous stderr_next."),
    ],
    async run(client, sandbox, args) {
      const out = await client.poll(sandbox, text(args.process_id), {
        stdoutFrom: Number(args.stdout_from ?? 0) || 0,
        stderrFrom: Number(args.stderr_from ?? 0) || 0,
      });
      return {
        state: out.state,
        exit_code: out.exitCode,
        stdout: out.stdout,
        stderr: out.stderr,
        stdout_next: out.stdoutNext,
        stderr_next: out.stderrNext,
        dropped_bytes: out.stdoutDropped + out.stderrDropped,
      };
    },
  },
  {
    name: "sandbox_kill",
    description: "Stop a background process and forget it.",
    args: [str("process_id", "The id sandbox_spawn returned.")],
    async run(client, sandbox, args) {
      await client.kill(sandbox, text(args.process_id));
      return { killed: true };
    },
  },
];

/**
 * Resolves the sandbox name for a turn.
 *
 * The framework's own conversation identifier is the name, with no mapping
 * table anywhere: one thread is one sandbox, and two threads never share a
 * filesystem. Falling back to a fixed name when the framework supplies no
 * thread would silently do the opposite, so that is an error unless the
 * caller named a sandbox itself.
 */
export function resolveSandboxName(options: {
  threadId?: string;
  sandbox?: string;
  prefix?: string;
}): string {
  const { threadId, sandbox, prefix = "" } = options;
  if (sandbox) return sandbox;
  if (!threadId) {
    throw new Error(
      "sandbox tools need a thread id to name the sandbox, and this turn has none. " +
        "Pass `sandbox` to pin one name, or run the agent with memory enabled so it " +
        "has a thread.",
    );
  }
  return `${prefix}${threadId}`;
}
