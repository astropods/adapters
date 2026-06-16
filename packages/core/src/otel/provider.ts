import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  NodeTracerProvider,
} from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

let cached: NodeTracerProvider | null | undefined;

export interface AstroTracerProviderOptions {
  /**
   * Whether to register the provider as the OpenTelemetry global
   * (i.e. set it via `trace.setGlobalTracerProvider`). Defaults to `true`.
   *
   * Set to `false` when the provider will be passed explicitly to
   * instrumentation that accepts a tracer (e.g. AI SDK
   * `experimental_telemetry: { tracer }`). Because the provider is cached
   * after the first call, the first caller's `register` setting wins for
   * the lifetime of the process.
   */
  register?: boolean;
}

/**
 * Returns a shared `NodeTracerProvider` wired to the OTLP HTTP exporter,
 * or `null` if `OTEL_EXPORTER_OTLP_ENDPOINT` is unset. Idempotent.
 */
export function getOrCreateAstroTracerProvider(
  options: AstroTracerProviderOptions = {}
): NodeTracerProvider | null {
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
