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
});
