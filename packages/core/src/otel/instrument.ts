import { getOrCreateAstroTracerProvider } from "./provider.js";
import { patchGlobalFetch } from "./fetch.js";

export interface InstrumentHttpOptions {}

/**
 * Patches `globalThis.fetch` to emit OpenTelemetry HTTP CLIENT spans.
 * No-op when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset. Idempotent.
 */
export function instrumentHttp(_options?: InstrumentHttpOptions): void {
  const provider = getOrCreateAstroTracerProvider();
  if (!provider) return;
  patchGlobalFetch();
}
