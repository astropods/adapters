import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  NodeTracerProvider,
} from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

let cached: NodeTracerProvider | null | undefined;

/**
 * Returns a shared `NodeTracerProvider` wired to the OTLP HTTP exporter,
 * or `null` if `OTEL_EXPORTER_OTLP_ENDPOINT` is unset. Idempotent.
 */
export function getOrCreateAstroTracerProvider(): NodeTracerProvider | null {
  if (cached !== undefined) return cached;

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    cached = null;
    return null;
  }

  const tracesUrl = `${endpoint.replace(/\/+$/, "")}/v1/traces`;

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      "service.name": process.env.ASTRO_AGENT_NAME ?? "astro-agent",
      "service.version": process.env.ASTRO_AGENT_BUILD ?? "dev",
    }),
    spanProcessors: [
      new BatchSpanProcessor(new OTLPTraceExporter({ url: tracesUrl })),
    ],
  });
  provider.register();

  const flushAndExit = async (signal: NodeJS.Signals) => {
    try {
      await provider.forceFlush();
      await provider.shutdown();
    } catch {}
    process.exit(signal === "SIGINT" ? 130 : 0);
  };
  process.once("SIGTERM", flushAndExit);
  process.once("SIGINT", flushAndExit);

  cached = provider;
  return provider;
}

export function _resetAstroTracerProviderForTests(): void {
  cached = undefined;
}
