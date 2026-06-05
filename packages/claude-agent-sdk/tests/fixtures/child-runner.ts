import { spawn } from "bun";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const scenariosDir = join(here, "..", "scenarios");

export interface RunOptions {
  /** Environment variables to set in the child process. */
  env?: Record<string, string>;
  /** Timeout in ms after which the child is killed. Default 10s. */
  timeoutMs?: number;
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Parsed JSON from the LAST line of stdout, if it's valid JSON. */
  result: any;
}

/**
 * Run a scenario file (e.g. "tier-1-env-unset.ts") as a child Bun process.
 * Each scenario runs in a fresh process so the adapter's global side effects
 * (OTel provider registration, signal handlers) don't bleed between tests.
 *
 * Scenarios are expected to print a single line of JSON describing their
 * result to stdout. The runner parses that line and returns it as `result`.
 */
export async function runScenario(
  scenarioFile: string,
  options: RunOptions = {},
): Promise<RunResult> {
  const proc = spawn({
    cmd: ["bun", "run", join(scenariosDir, scenarioFile)],
    env: { ...process.env, ...(options.env ?? {}) },
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeout = options.timeoutMs ?? 10_000;
  const timer = setTimeout(() => proc.kill(), timeout);

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(timer);

  // Look for the last JSON-parseable line of stdout.
  let result: any = null;
  const lines = stdout.trim().split("\n").reverse();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      result = JSON.parse(trimmed);
      break;
    } catch {
      // not JSON, skip
    }
  }

  return { exitCode, stdout, stderr, result };
}
