import { getOrCreateAstroTracerProvider } from "@astropods/adapter-core";
import type { TelemetrySettings } from "ai";

/**
 * Returns AI SDK `experimental_telemetry` settings wired to Astro's OTLP
 * exporter. Spread into the agent settings (or per-call options) so spans
 * route to Astro without touching the OpenTelemetry global.
 *
 * - When `OTEL_EXPORTER_OTLP_ENDPOINT` is set, returns
 *   `{ isEnabled: true, tracer }` with a tracer scoped to `"ai.sdk"`.
 * - When the env var is unset (e.g. local development), returns
 *   `{ isEnabled: false }`. The AI SDK skips telemetry entirely.
 *
 * ```typescript
 * import { Experimental_Agent as Agent } from "ai";
 * import { astroTelemetry } from "@astropods/adapter-ai-sdk";
 *
 * const agent = new Agent({
 *   model: openai("gpt-4o"),
 *   experimental_telemetry: astroTelemetry(),
 * });
 * ```
 */
export function astroTelemetry(): TelemetrySettings {
  const provider = getOrCreateAstroTracerProvider({ register: false });
  if (!provider) return { isEnabled: false };
  return { isEnabled: true, tracer: provider.getTracer("ai.sdk") };
}
