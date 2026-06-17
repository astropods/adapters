import { getOrCreateAstroTracerProvider } from "@astropods/adapter-core";
import type { TelemetrySettings } from "ai";

export function astroTelemetry(): TelemetrySettings {
  const provider = getOrCreateAstroTracerProvider({ register: false });
  if (!provider) return { isEnabled: false };
  return { isEnabled: true, tracer: provider.getTracer("ai.sdk") };
}
