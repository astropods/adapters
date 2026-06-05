/**
 * Tier 2 wire scenario: import the adapter (registering the OTLP provider
 * pointed at the parent test's fake collector), emit a manual span via the
 * global tracer, then trigger SIGTERM. The adapter's shutdown handler runs
 * `provider.forceFlush()` + `shutdown()` before calling `process.exit(0)`,
 * which flushes the span over the wire to the collector.
 *
 * The parent test waits for the child to exit (clean exit means flush
 * completed) and then asserts on the collected request bodies.
 */
import { trace } from "@opentelemetry/api";
// Importing the adapter executes its top-level side effect: env read,
// provider registration, instrumentation, SIGTERM/SIGINT handler install.
import "../../src/index.js";

const tracer = trace.getTracer("tier-2-emit-span", "0.0.0");
const span = tracer.startSpan("manual.test.span", {
  attributes: { "test.marker": "tier-2" },
});
span.end();

// Trigger the adapter's SIGTERM handler. It will:
//   1. forceFlush() the BatchSpanProcessor (sending our span over the wire)
//   2. shutdown() the provider
//   3. process.exit(0)
process.kill(process.pid, "SIGTERM");
