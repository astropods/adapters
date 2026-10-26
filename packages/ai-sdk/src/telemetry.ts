import { OpenTelemetry } from "@ai-sdk/otel";
import { getOrCreateAstroTracerProvider } from "@astropods/adapter-core";
import type { Tracer } from "@opentelemetry/api";
import type { TelemetryOptions } from "ai";

// AI SDK 6 reads `tracer`; AI SDK 7 ignores it and sends spans only to `integrations`.
//
// Takes the provider's default global registration, which `withActorHeaders`
// needs: `propagation.inject` writes nothing without a global propagator and
// context manager, so an unregistered provider still exports spans but leaves
// gateway requests with no trace context and no way to join a billed figure to
// a trace. Registration is additive for the export either way, since the
// tracer handed to the AI SDK below comes from this provider explicitly.
// See getOrCreateAstroTracerProvider for the opt-out.
export function astroTelemetry(): TelemetryOptions & { tracer?: Tracer } {
  const provider = getOrCreateAstroTracerProvider();
  if (!provider) return { isEnabled: false };
  const tracer = provider.getTracer("ai.sdk");
  return { isEnabled: true, tracer, integrations: [new OpenTelemetry({ tracer })] };
}
