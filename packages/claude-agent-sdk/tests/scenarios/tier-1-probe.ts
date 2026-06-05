/**
 * Tier 1 probe: imports the adapter and the underlying SDK separately, then
 * reports back what state the runtime ended up in. Run as a child process so
 * the adapter's global side effects (provider registration, signal handlers)
 * don't leak between tests.
 *
 * Output is a single line of JSON on stdout. The parent test process parses
 * it via `runScenario` and asserts on the result.
 */
import { trace } from "@opentelemetry/api";
import * as adapter from "../../src/index.js";
import * as originalSdk from "@anthropic-ai/claude-agent-sdk";

// The adapter's instrumentation block only runs when this env var is set.
// The parent test toggles it per scenario.
const hadEndpoint = Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT);

// Reference comparison: if the SDK was patched, adapter.query is a wrapper
// produced by OpenInference and is no longer the same function as the
// original SDK export.
const queryPatched = adapter.query !== originalSdk.query;

// Behavioral check: when the adapter registered a real provider, a span
// emitted via the global tracer is recording. With no endpoint, the global
// stays the proxy-over-noop default and spans are non-recording.
const tracer = trace.getTracer("tier-1-probe", "0.0.0");
const span = tracer.startSpan("probe");
const spanRecording = span.isRecording();
span.end();

process.stdout.write(
  JSON.stringify({ hadEndpoint, queryPatched, spanRecording }) + "\n",
);
