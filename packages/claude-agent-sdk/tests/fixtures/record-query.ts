/**
 * Manually-run fixture recorder. Calls the real Claude Agent SDK with a
 * deterministic prompt, captures every event emitted, and writes them to
 * `recorded-query.json`. Run when the SDK's message shape changes meaningfully
 * (the Tier 3 replay test will start failing if so).
 *
 * Prerequisites:
 *   - ANTHROPIC_API_KEY set in the environment
 *   - `claude` binary installed (the SDK spawns it as a subprocess)
 *
 * Usage:
 *   bun run tests/fixtures/record-query.ts
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is required to record a fixture.");
  process.exit(1);
}

const events: unknown[] = [];
for await (const event of query({
  prompt: "Reply with the single word: ok",
  options: { model: "claude-haiku-4-5" },
})) {
  events.push(event);
}

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "recorded-query.json");
writeFileSync(out, JSON.stringify(events, null, 2) + "\n");
console.log(`Recorded ${events.length} events → ${out}`);
