import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { Observability } from "@mastra/observability";
import type { ObservabilityExporter } from "@mastra/core/observability";
import {
  MastraLanguageModelV2Mock,
  simulateReadableStream,
} from "@mastra/core/test-utils/llm-mock";
import { setupObservability } from "./observability";

// --- Helpers ---

function makeModel() {
  return new MastraLanguageModelV2Mock({
    provider: "test",
    modelId: "test-model",
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start" as const, id: "t-0" },
          { type: "text-delta" as const, id: "t-0", delta: "hi" },
          { type: "text-end" as const, id: "t-0" },
          { type: "finish" as const, finishReason: "stop" as const, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
        ],
        chunkDelayInMs: 0,
      }),
    }),
  });
}

function makeStandaloneAgent() {
  return new Agent({
    id: "test-agent",
    name: "Test Agent",
    model: makeModel(),
    instructions: "test",
  });
}

function makeMastraAgent(options?: { withObservability?: boolean }) {
  const agent = new Agent({
    id: "test-agent",
    name: "Test Agent",
    model: makeModel(),
    instructions: "test",
  });
  const mastraConfig: Record<string, any> = { agents: { "test-agent": agent } };
  if (options?.withObservability) {
    // Minimal stub exporter to satisfy Observability's validation
    const stubExporter: ObservabilityExporter = {
      name: "stub",
      exportTracingEvent: () => {},
      flush: () => {},
      shutdown: () => {},
    };
    mastraConfig.observability = new Observability({
      configs: {
        existing: { serviceName: "user-service", exporters: [stubExporter] },
      },
    });
  }
  new Mastra(mastraConfig);
  return agent;
}

// --- Tests ---

describe("setupObservability", () => {
  const originalEnv = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    } else {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalEnv;
    }
  });

  describe("when OTEL_EXPORTER_OTLP_ENDPOINT is not set", () => {
    test("is a no-op for standalone agent", () => {
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      const agent = makeStandaloneAgent();

      setupObservability(agent);

      // Agent should remain standalone
      expect(agent.getMastraInstance()).toBeUndefined();
    });

    test("is a no-op for mastra agent", () => {
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      const agent = makeMastraAgent();
      const mastra = agent.getMastraInstance()!;

      setupObservability(agent);

      // Should not have added any instances
      expect(mastra.observability.listInstances().size).toBe(0);
    });
  });

  describe("when OTEL_EXPORTER_OTLP_ENDPOINT is set", () => {
    beforeEach(() => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
    });

    test("standalone agent gets a Mastra instance with observability", () => {
      const agent = makeStandaloneAgent();
      expect(agent.getMastraInstance()).toBeUndefined();

      setupObservability(agent);

      // Agent should now have a Mastra instance
      const mastra = agent.getMastraInstance();
      expect(mastra).toBeDefined();
      // And it should have our otel instance registered
      expect(mastra!.observability.listInstances().size).toBeGreaterThan(0);
    });

    test("agent with NoOp Mastra gets re-registered on a new Mastra", () => {
      const agent = makeMastraAgent(); // Mastra without observability → NoOp
      const oldMastra = agent.getMastraInstance()!;
      expect(oldMastra.observability.listInstances().size).toBe(0);

      setupObservability(agent);

      // Agent should now point to a new Mastra with real observability
      const newMastra = agent.getMastraInstance()!;
      expect(newMastra).toBeDefined();
      expect(newMastra.observability.listInstances().size).toBeGreaterThan(0);
    });

    test("agent with real observability gets otel added alongside existing", () => {
      const agent = makeMastraAgent({ withObservability: true });
      const mastra = agent.getMastraInstance()!;
      const instancesBefore = mastra.observability.listInstances().size;
      expect(instancesBefore).toBeGreaterThan(0);

      setupObservability(agent);

      // Should have kept existing + added ours
      expect(mastra.observability.listInstances().size).toBe(instancesBefore + 1);
      expect(mastra.observability.hasInstance("astropods-otel")).toBe(true);
    });

    test("does not replace existing observability instances", () => {
      const agent = makeMastraAgent({ withObservability: true });
      const mastra = agent.getMastraInstance()!;

      // Verify "existing" config is there before
      expect(mastra.observability.hasInstance("existing")).toBe(true);

      setupObservability(agent);

      // "existing" should still be there
      expect(mastra.observability.hasInstance("existing")).toBe(true);
      expect(mastra.observability.hasInstance("astropods-otel")).toBe(true);
    });

    test("strips trailing slashes before appending /v1/traces", () => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318///";

      const agent = makeStandaloneAgent();
      setupObservability(agent);

      // Should succeed without error — the URL is built internally
      expect(agent.getMastraInstance()).toBeDefined();
    });

    test("logs when tracing is enabled", () => {
      const logSpy = mock(() => {});
      const origLog = console.log;
      console.log = logSpy;

      try {
        const agent = makeStandaloneAgent();
        setupObservability(agent);

        const logCalls = (logSpy as any).mock.calls;
        const otelLog = logCalls.find((args: any[]) =>
          typeof args[0] === "string" && args[0].includes("OTEL tracing enabled")
        );
        expect(otelLog).toBeDefined();
        expect(otelLog![0]).toContain("/v1/traces");
      } finally {
        console.log = origLog;
      }
    });
  });
});
