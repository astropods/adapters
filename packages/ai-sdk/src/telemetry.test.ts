import { beforeEach, describe, expect, test } from "bun:test";
import {
  _resetAstroTracerProviderForTests,
  getOrCreateAstroTracerProvider,
} from "@astropods/adapter-core";
import { trace } from "@opentelemetry/api";

import { astroTelemetry } from "./telemetry";

// The endpoint-unset case (astroTelemetry → { isEnabled: false }) is covered by
// core's provider tests.
//
// Set per test rather than once at module load: the provider is cached and the
// endpoint is read at creation, so another test file deleting the variable
// between this module's load and its tests would otherwise cache a null
// provider here and fail every test below for an unrelated reason.
beforeEach(() => {
  _resetAstroTracerProviderForTests();
  trace.disable();
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
});

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

  // withActorHeaders puts W3C trace context on gateway requests through
  // propagation.inject, which writes nothing without a globally registered
  // propagator and context manager. Without this the gateway call starts a
  // trace the agent's span is not part of, and bifrost-otel's billed record
  // cannot be joined to the agent's trace.
  test("registers the provider as the OpenTelemetry global", () => {
    astroTelemetry();
    // Asserted against the provider itself rather than a before/after
    // comparison: the provider is cached process-wide, so an earlier call in
    // this file may already have registered it.
    expect(globalDelegate()).toBe(getOrCreateAstroTracerProvider());
  });
});

describe("astroTelemetry with AI SDK 7", () => {
  test("hands the tracer to an integration, since AI SDK 7 ignores the tracer field", async () => {
    const { ToolLoopAgent } = await import("ai");
    const { MockLanguageModelV4 } = await import("ai/test");
    const settings = astroTelemetry();
    const tracer = settings.tracer!;
    let spans = 0;
    const startSpan = tracer.startSpan.bind(tracer);
    tracer.startSpan = ((...args: Parameters<typeof startSpan>) => {
      spans++;
      return startSpan(...args);
    }) as typeof tracer.startSpan;
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: "hello" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      }),
    });

    await new ToolLoopAgent({ model, telemetry: settings }).generate({ prompt: "hi" });

    expect(spans).toBeGreaterThan(0);
  });
});
