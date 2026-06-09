import { spawn } from "bun";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const scenariosDir = join(here, "..", "scenarios");

export type Runtime = "bun" | "node";

export interface RunOptions {
  /** Which JS runtime to launch the scenario under. */
  runtime: Runtime;
  /** Environment variables for the child process. */
  env?: Record<string, string>;
  /** Timeout in ms after which the child is killed. Default 15s. */
  timeoutMs?: number;
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Parsed JSON from the LAST JSON-parseable line of stdout, if any. */
  result: any;
}

/** Runs an ESM scenario in a fresh child process under Bun or Node. */
export async function runScenario(
  scenarioFile: string,
  options: RunOptions,
): Promise<RunResult> {
  const cmd =
    options.runtime === "bun"
      ? ["bun", "run", join(scenariosDir, scenarioFile)]
      : ["node", join(scenariosDir, scenarioFile)];

  const proc = spawn({
    cmd,
    env: { ...process.env, ...(options.env ?? {}) },
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeout = options.timeoutMs ?? 15_000;
  const timer = setTimeout(() => proc.kill(), timeout);

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(timer);

  let result: any = null;
  const lines = stdout.trim().split("\n").reverse();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      result = JSON.parse(trimmed);
      break;
    } catch {
      // Not JSON, keep scanning.
    }
  }

  return { exitCode, stdout, stderr, result };
}
