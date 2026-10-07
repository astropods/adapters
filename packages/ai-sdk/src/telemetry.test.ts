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
