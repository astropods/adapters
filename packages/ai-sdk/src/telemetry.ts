import { OpenTelemetry } from "@ai-sdk/otel";
import { getOrCreateAstroTracerProvider } from "@astropods/adapter-core";
import type { Tracer } from "@opentelemetry/api";
import type { Telemetry, TelemetryOptions } from "ai";

// AI SDK 6 reads `tracer`; AI SDK 7 ignores it and sends spans only to `integrations`.
export function astroTelemetry(): TelemetryOptions & { tracer?: Tracer } {
  const provider = getOrCreateAstroTracerProvider({ register: false });
  if (!provider) return { isEnabled: false };
  const tracer = provider.getTracer("ai.sdk");
  // Cast bridges a @ai-sdk/provider-utils version skew (5.0.82 vs 5.0.83) between
  // @ai-sdk/otel and ai that makes FlexibleSchema structurally incompatible at the
  // type level only; at runtime the shapes are identical.
  const otel = new OpenTelemetry({ tracer }) as unknown as Telemetry;
  return { isEnabled: true, tracer, integrations: [otel] };
}
