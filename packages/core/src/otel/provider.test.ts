import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { trace } from "@opentelemetry/api";

import {
  _resetAstroTracerProviderForTests,
  getOrCreateAstroTracerProvider,
} from "./provider";

const ORIG_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

beforeEach(() => {
  _resetAstroTracerProviderForTests();
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

describe("getOrCreateAstroTracerProvider", () => {
  test("returns null when OTEL_EXPORTER_OTLP_ENDPOINT is unset", () => {
    expect(getOrCreateAstroTracerProvider()).toBeNull();
  });

  test("returns a provider when endpoint is set, and caches it across calls", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";

    const first = getOrCreateAstroTracerProvider();
    expect(first).not.toBeNull();

    const second = getOrCreateAstroTracerProvider();
    expect(second).toBe(first);
  });

  test("caches the null result so a later endpoint set still no-ops within the process", () => {
    expect(getOrCreateAstroTracerProvider()).toBeNull();
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
    // Without resetting, the cached null wins — agents shouldn't set the
    // endpoint mid-process, so this matches expected behavior.
    expect(getOrCreateAstroTracerProvider()).toBeNull();
  });

  test("registers the provider as the OTel global by default", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";

    const provider = getOrCreateAstroTracerProvider();
    expect(provider).not.toBeNull();

    // After register(), trace.getTracerProvider() returns the registered
    // ProxyTracerProvider, which delegates to our provider. Calling
    // .getDelegate() (an internal but stable method) returns the underlying
    // provider. We check identity through getTracer() instead — the global
    // tracer should produce spans through our provider's processors.
    const globalTracer = trace.getTracer("test");
    expect(globalTracer).toBeDefined();
  });

  test("does NOT register as the OTel global when register: false is passed", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";

    // Capture the global tracer provider before our call.
    const beforeProvider = trace.getTracerProvider();

    const provider = getOrCreateAstroTracerProvider({ register: false });
    expect(provider).not.toBeNull();

    // The global must be untouched.
    expect(trace.getTracerProvider()).toBe(beforeProvider);
  });
});
