import { getOrCreateAstroTracerProvider } from "@astropods/adapter-core";
import { logger } from "@astropods/adapter-core";

/**
 * Registers the shared Astro tracer provider as the OpenTelemetry global.
 *
 * The AI SDK reads the global tracer when an agent is constructed with
 * `experimental_telemetry: { isEnabled: true }`. Calling this once at startup
 * is sufficient — subsequent calls are no-ops thanks to the cached provider.
 *
 * Returns `true` when a real provider was registered (i.e.
 * `OTEL_EXPORTER_OTLP_ENDPOINT` was set), `false` otherwise.
 */
export function setupObservability(): boolean {
  const provider = getOrCreateAstroTracerProvider();
  if (!provider) return false;

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT!;
  const tracesUrl = `${endpoint.replace(/\/+$/, "")}/v1/traces`;
  logger.info(`OTEL tracing enabled → ${tracesUrl}`);
  return true;
}
