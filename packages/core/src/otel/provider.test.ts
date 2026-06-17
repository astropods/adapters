import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { trace } from "@opentelemetry/api";

import {
  _resetAstroTracerProviderForTests,
  buildTracesUrl,
  getOrCreateAstroTracerProvider,
} from "./provider";

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
    // Cached null wins — endpoint shouldn't change mid-process.
    expect(getOrCreateAstroTracerProvider()).toBeNull();
  });

  // OTel's global is a stable proxy; check its delegate, not its identity.
  const globalDelegate = (): unknown =>
    (trace.getTracerProvider() as { getDelegate(): unknown }).getDelegate();

  test("registers the provider as the OTel global by default", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";

    const provider = getOrCreateAstroTracerProvider();
    expect(provider).not.toBeNull();
    expect(globalDelegate()).toBe(provider);
  });

  test("does NOT register as the OTel global when register: false is passed", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";

    const provider = getOrCreateAstroTracerProvider({ register: false });
    expect(provider).not.toBeNull();
    expect(globalDelegate()).not.toBe(provider);
  });
});

describe("buildTracesUrl", () => {
  test("appends /v1/traces to a bare endpoint", () => {
    expect(buildTracesUrl("http://localhost:4318")).toBe(
      "http://localhost:4318/v1/traces"
    );
  });

  test("strips trailing slashes before appending /v1/traces", () => {
    expect(buildTracesUrl("http://localhost:4318/")).toBe(
      "http://localhost:4318/v1/traces"
    );
    expect(buildTracesUrl("http://localhost:4318///")).toBe(
      "http://localhost:4318/v1/traces"
    );
  });

  test("preserves a path prefix on the endpoint", () => {
    expect(buildTracesUrl("http://localhost:4318/otlp/")).toBe(
      "http://localhost:4318/otlp/v1/traces"
    );
  });
});
