import { describe, expect, test } from "bun:test";

import { instrumentLangChain } from "./instrumentation";

// The endpoint-unset case (instrumentLangChain → false) is covered by core's
// provider tests; replicating it here would need a cache reset between tests,
// which leaks process-wide state. Set the endpoint so the provider is built.
process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";

describe("instrumentLangChain", () => {
  test("returns true when the endpoint is set and is idempotent", () => {
    expect(instrumentLangChain()).toBe(true);
    // Second call must not double-instrument the callback manager.
    expect(instrumentLangChain()).toBe(true);
  });
});
