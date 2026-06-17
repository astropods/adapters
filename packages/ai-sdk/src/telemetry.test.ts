import { describe, expect, test } from "bun:test";
import { trace } from "@opentelemetry/api";

import { astroTelemetry } from "./telemetry";

// The endpoint-unset case (astroTelemetry → { isEnabled: false }) is covered by
// core's provider tests; replicating it here would need cache reset between
// tests, which leaks process-wide state.
process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";

const globalDelegate = (): unknown =>
  (trace.getTracerProvider() as { getDelegate(): unknown }).getDelegate();

describe("astroTelemetry", () => {
  test("returns isEnabled: true with a usable tracer when the endpoint is set", () => {
    const settings = astroTelemetry();
    expect(settings.isEnabled).toBe(true);
    expect(settings.tracer).toBeDefined();
    const span = settings.tracer!.startSpan("test-span");
    expect(span).toBeDefined();
    span.end();
  });

  test("does NOT register the provider as the OpenTelemetry global", () => {
    const before = globalDelegate();
    astroTelemetry();
    expect(globalDelegate()).toBe(before);
  });
});
