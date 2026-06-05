import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { runScenario } from "./fixtures/child-runner";
import { FakeCollector } from "./fixtures/fake-collector";
import { decodeOtlpRequest, type DecodedSpan } from "./fixtures/span-decoder";

describe("tier 3 — replay (OpenInference instrumentation against recorded SDK events)", () => {
  let collector: FakeCollector;
  let endpoint: string;

  beforeEach(() => {
    collector = new FakeCollector();
    endpoint = collector.start().url;
  });

  afterEach(() => {
    collector.stop();
  });

  test("produces a ClaudeAgent.query AGENT span with session, model, and usage attributes", { timeout: 15000 }, async () => {
    const { exitCode, stderr } = await runScenario(
      "tier-3-replay-scenario.ts",
      {
        env: {
          OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
          ASTRO_AGENT_NAME: "tier-3-agent",
          ASTRO_AGENT_BUILD: "tier-3-build",
        },
        timeoutMs: 15_000,
      },
    );

    expect(exitCode, `stderr:\n${stderr}`).toBe(0);
    expect(collector.requests.length).toBeGreaterThanOrEqual(1);

    // Combine spans across all request batches the collector received.
    const allSpans: DecodedSpan[] = collector.requests.flatMap((r) =>
      decodeOtlpRequest(r.body),
    );

    const agentSpan = allSpans.find((s) => s.name === "ClaudeAgent.query");
    expect(agentSpan, "expected an OpenInference ClaudeAgent.query span").toBeDefined();

    // Resource-level attributes still come from the adapter's provider config.
    expect(agentSpan!.resourceAttributes["service.name"]).toBe("tier-3-agent");
    expect(agentSpan!.resourceAttributes["service.version"]).toBe("tier-3-build");

    // OpenInference attribute conventions, populated from the recorded events.
    // These values come from tests/fixtures/recorded-query.json — refresh that
    // file via tests/fixtures/record-query.ts and update these expectations if
    // the SDK shape changes.
    expect(agentSpan!.attributes["openinference.span.kind"]).toBe("AGENT");
    expect(agentSpan!.attributes["session.id"]).toBe(
      "6f4a2f50-13da-472f-953d-5b6851f535df",
    );
    expect(agentSpan!.attributes["llm.model_name"]).toBe("claude-haiku-4-5");
    expect(agentSpan!.attributes["llm.token_count.prompt"]).toBe(10);
    expect(agentSpan!.attributes["llm.token_count.completion"]).toBe(55);
    expect(agentSpan!.attributes["llm.token_count.total"]).toBe(65);
  });
});
