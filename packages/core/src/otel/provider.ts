import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  NodeTracerProvider,
} from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

let cached: NodeTracerProvider | null | undefined;

export interface AstroTracerProviderOptions {
  /** Whether to set the provider as the OTel global. Defaults to `true`, and
   *  `ASTRO_OTEL_REGISTER=false` overrides that default. First caller wins
   *  because the provider is cached. */
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

  // First registration wins and OTel refuses later ones, so this cannot
  // clobber a provider an embedding app already registered. The reverse is
  // possible: an adapter registers at import time and pre-empts one the app
  // sets up afterwards. ASTRO_OTEL_REGISTER=false opts out for an app running
  // its own export. Registration is still worth defaulting to, because
  // propagation.inject writes nothing without a global propagator and context
  // manager, which is what withActorHeaders needs to put trace context on a
  // gateway request.
  if (options.register !== false && process.env.ASTRO_OTEL_REGISTER !== "false") {
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
