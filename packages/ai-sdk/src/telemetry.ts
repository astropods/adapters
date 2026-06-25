import { getOrCreateAstroTracerProvider } from "@astropods/adapter-core";
import type { TelemetryOptions } from "ai";
import type { Tracer } from "@opentelemetry/api";

type AstroTelemetrySettings = TelemetryOptions & { tracer?: Tracer };

export function astroTelemetry(): AstroTelemetrySettings {
  const provider = getOrCreateAstroTracerProvider({ register: false });
  if (!provider) return { isEnabled: false };
  return { isEnabled: true, tracer: provider.getTracer("ai.sdk") };
}
