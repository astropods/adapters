/**
 * Stub stand-in for `@anthropic-ai/claude-agent-sdk` used by the Tier 3
 * replay test. Exports a `query()` that yields the events recorded in
 * `recorded-query.json` so OpenInference's instrumentation runs against
 * realistic SDK message shapes without needing a real Claude binary or
 * API key.
 *
 * To refresh the fixture, run `tests/fixtures/record-query.ts` against a
 * real SDK install with ANTHROPIC_API_KEY set.
 */
import events from "./recorded-query.json" with { type: "json" };

export async function* query(_params: { prompt: string; options?: unknown }) {
  for (const event of events) yield event;
}

// Other named exports (tool, AbortError, etc.) are intentionally omitted —
// only `query` participates in instrumentation. The adapter's `export *` over
// this module will simply re-export whatever is here, which is sufficient for
// Tier 3 assertions.
