import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { trace } from "@opentelemetry/api";

import {
  _resetAstroTracerProviderForTests,
  getOrCreateAstroTracerProvider,
} from "@astropods/adapter-core";
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
    const span = settings.tracer!.startSpan("test-span");
    expect(span).toBeDefined();
    span.end();
  });

  test("does NOT register the provider as the OpenTelemetry global", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";

    astroTelemetry();

    // OTel's global tracer provider is a stable proxy; check its delegate, not its identity.
    const astroProvider = getOrCreateAstroTracerProvider();
    const globalDelegate = (
      trace.getTracerProvider() as { getDelegate(): unknown }
    ).getDelegate();
    expect(globalDelegate).not.toBe(astroProvider);
  });
});
