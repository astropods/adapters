/**
 * Tier 3 replay scenario: feed the adapter's `instrumentSDK` a replay SDK
 * (yielding recorded `SDKMessage` events from `recorded-query.json`) instead
 * of the real `@anthropic-ai/claude-agent-sdk`. Drives OpenInference's
 * instrumentation through a full `query()` cycle so the parent test can
 * assert on the resulting `ClaudeAgent.query` AGENT span.
 *
 * Bypassing module mocking sidesteps Bun's runtime plugin limitations while
 * exercising the same `instrumentSDK` code path the real adapter calls.
 */
import { instrumentSDK } from "../../src/instrumentation.js";
import * as ReplaySDK from "../fixtures/replay-sdk.js";

const patched: typeof ReplaySDK = { ...ReplaySDK };
const ok = instrumentSDK(patched);
if (!ok) {
  process.stderr.write("instrumentSDK returned false; no endpoint set\n");
  process.exit(2);
}

// Drive a full query() cycle — OpenInference wraps this and emits a
// `ClaudeAgent.query` AGENT span as the recorded events are yielded.
for await (const _event of patched.query({ prompt: "Reply with the single word: ok" })) {
  // consume; instrumentation only fires while the iterator is being drained
}

// The SIGTERM handler installed by instrumentSDK does forceFlush + shutdown
// + clean exit, sending the span to the configured fake collector.
process.kill(process.pid, "SIGTERM");
