import { getOrCreateAstroTracerProvider } from "@astropods/adapter-core";
import type { Tracer } from "@opentelemetry/api";
import type { TelemetryOptions } from "ai";

export function astroTelemetry(): TelemetryOptions & { tracer?: Tracer } {
  const provider = getOrCreateAstroTracerProvider({ register: false });
  if (!provider) return { isEnabled: false };
  return { isEnabled: true, tracer: provider.getTracer("ai.sdk") };
}
