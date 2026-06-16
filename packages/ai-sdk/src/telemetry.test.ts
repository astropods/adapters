import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { trace } from "@opentelemetry/api";

import { _resetAstroTracerProviderForTests } from "../../core/dist/otel/provider.js";
import { astroTelemetry } from "./telemetry";

const ORIG_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

beforeEach(() => {
  _resetAstroTracerProviderForTests();
  trace.disable();
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
});

afterEach(() => {
  _resetAstroTracerProviderForTests();
  trace.disable();
  if (ORIG_ENDPOINT === undefined) {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  } else {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = ORIG_ENDPOINT;
  }
});

describe("astroTelemetry", () => {
  test("returns { isEnabled: false } when OTEL_EXPORTER_OTLP_ENDPOINT is unset", () => {
    const settings = astroTelemetry();
    expect(settings.isEnabled).toBe(false);
    expect(settings.tracer).toBeUndefined();
  });

  test("returns { isEnabled: true, tracer } when the endpoint is set", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";

    const settings = astroTelemetry();
    expect(settings.isEnabled).toBe(true);
    expect(settings.tracer).toBeDefined();
    // Smoke-check the tracer surface — it should produce spans.
    const span = settings.tracer!.startSpan("test-span");
    expect(span).toBeDefined();
    span.end();
  });

  test("does NOT register the provider as the OpenTelemetry global", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";

    const beforeProvider = trace.getTracerProvider();
    astroTelemetry();
    // Global must be untouched — that's the whole point of the explicit helper.
    expect(trace.getTracerProvider()).toBe(beforeProvider);
  });
});
