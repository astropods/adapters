import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  NodeTracerProvider,
} from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

let cached: NodeTracerProvider | null | undefined;

export interface AstroTracerProviderOptions {
  /** Whether to set the provider as the OTel global. Defaults to `true`. First caller wins because the provider is cached. */
  register?: boolean;
}

export function buildTracesUrl(endpoint: string): string {
  return `${endpoint.replace(/\/+$/, "")}/v1/traces`;
}

export function getOrCreateAstroTracerProvider(
  options: AstroTracerProviderOptions = {}
): NodeTracerProvider | null {
  if (cached !== undefined) return cached;

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    cached = null;
    return null;
  }

  const tracesUrl = buildTracesUrl(endpoint);

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      "service.name": process.env.ASTRO_AGENT_NAME ?? "astro-agent",
      "service.version": process.env.ASTRO_AGENT_BUILD ?? "dev",
    }),
    spanProcessors: [
      new BatchSpanProcessor(new OTLPTraceExporter({ url: tracesUrl })),
    ],
  });

  if (options.register !== false) {
    provider.register();
  }

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
