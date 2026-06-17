import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { LangChainInstrumentation } from "@arizeai/openinference-instrumentation-langchain";

import { instrumentLangChain } from "./instrumentation";

// The endpoint-unset case (instrumentLangChain → false) is covered by core's
// provider tests; replicating it here would need a cache reset between tests,
// which leaks process-wide state. Set the endpoint so the provider is built,
// and restore it afterwards so it does not leak into sibling test files.
const PRIOR_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";

afterAll(() => {
  if (PRIOR_ENDPOINT === undefined) {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  } else {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = PRIOR_ENDPOINT;
  }
});

describe("instrumentLangChain", () => {
  test("instruments the callback manager exactly once across repeated calls", () => {
    // Spy on the patch entry point: idempotency means the shared callback
    // manager is patched once no matter how many times we enable tracing.
    const manuallyInstrument = spyOn(
      LangChainInstrumentation.prototype,
      "manuallyInstrument"
    );

    try {
      expect(instrumentLangChain()).toBe(true);
      expect(instrumentLangChain()).toBe(true);

      expect(manuallyInstrument).toHaveBeenCalledTimes(1);
    } finally {
      manuallyInstrument.mockRestore();
    }
  });
});
