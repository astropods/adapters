import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { runScenario } from "./fixtures/child-runner";
import { FakeCollector } from "./fixtures/fake-collector";
import { decodeOtlpRequest } from "./fixtures/span-decoder";

describe("tier 2 — wire", () => {
  let collector: FakeCollector;
  let endpoint: string;

  beforeEach(() => {
    collector = new FakeCollector();
    endpoint = collector.start().url;
  });

  afterEach(() => {
    collector.stop();
  });

  test("emits a span that reaches the configured collector with the right resource attrs", { timeout: 15000 }, async () => {
    const { exitCode, stderr } = await runScenario("tier-2-emit-span.ts", {
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
        ASTRO_AGENT_NAME: "tier-2-agent",
        ASTRO_AGENT_BUILD: "tier-2-build-abc",
      },
      timeoutMs: 14000,
    });

    expect(exitCode, `stderr:\n${stderr}`).toBe(0);
    expect(collector.requests.length).toBeGreaterThanOrEqual(1);

    const req = collector.requests[0];
    expect(req.url).toEndWith("/v1/traces");
    expect(req.method).toBe("POST");
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.body.byteLength).toBeGreaterThan(0);

    // Decode the protobuf body and assert on the actual span content.
    const spans = decodeOtlpRequest(req.body);
    const ours = spans.find((s) => s.name === "manual.test.span");
    expect(ours, "expected a span named 'manual.test.span'").toBeDefined();
    expect(ours!.resourceAttributes["service.name"]).toBe("tier-2-agent");
    expect(ours!.resourceAttributes["service.version"]).toBe("tier-2-build-abc");
    expect(ours!.attributes["test.marker"]).toBe("tier-2");
    expect(ours!.scopeName).toBe("tier-2-emit-span");
  });
});
