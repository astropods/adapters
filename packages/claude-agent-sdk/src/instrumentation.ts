import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  NodeTracerProvider,
  BatchSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { ClaudeAgentSDKInstrumentation } from "@arizeai/openinference-instrumentation-claude-agent-sdk";

/**
 * Wire OpenTelemetry into a Claude Agent SDK namespace. When
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is set, this:
 *   - Builds a `NodeTracerProvider` with the right service.name/version resource,
 *     exporting to `<endpoint>/v1/traces` via the OTLP HTTP exporter.
 *   - Registers the provider globally so any `trace.getTracer(...)` call uses it.
 *   - Runs `ClaudeAgentSDKInstrumentation.manuallyInstrument(sdk)`, replacing
 *     `sdk.query` with an OpenInference-wrapped version.
 *   - Installs SIGTERM/SIGINT handlers that force-flush buffered spans before
 *     exiting (so the tail of an in-flight trace isn't dropped on container shutdown).
 *
 * Returns `true` when instrumentation was applied, `false` when no endpoint
 * was present (typical local-dev case — the agent runs untraced).
 *
 * Tests pass in a replay-SDK namespace here to verify span generation against
 * recorded SDK event shapes without needing real Claude API calls.
 */
export function instrumentSDK(sdk: Record<string, any>): boolean {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return false;

  const tracesUrl = `${endpoint.replace(/\/+$/, "")}/v1/traces`;

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      "service.name": process.env.ASTRO_AGENT_NAME ?? "claude-agent",
      "service.version": process.env.ASTRO_AGENT_BUILD ?? "dev",
    }),
    spanProcessors: [
      new BatchSpanProcessor(new OTLPTraceExporter({ url: tracesUrl })),
    ],
  });
  provider.register();

  const instrumentation = new ClaudeAgentSDKInstrumentation();
  instrumentation.setTracerProvider(provider);
  instrumentation.manuallyInstrument(sdk);

  const flushAndExit = async (signal: NodeJS.Signals) => {
    try {
      await provider.forceFlush();
      await provider.shutdown();
    } catch {}
    process.exit(signal === "SIGINT" ? 130 : 0);
  };
  process.once("SIGTERM", flushAndExit);
  process.once("SIGINT", flushAndExit);

  return true;
}
