import { OpenTelemetry } from "@ai-sdk/otel";
import { getOrCreateAstroTracerProvider } from "@astropods/adapter-core";
import type { Tracer } from "@opentelemetry/api";
import type { Telemetry, TelemetryOptions } from "ai";

// AI SDK 6 reads `tracer`; AI SDK 7 ignores it and sends spans only to `integrations`.
export function astroTelemetry(): TelemetryOptions & { tracer?: Tracer } {
  const provider = getOrCreateAstroTracerProvider({ register: false });
  if (!provider) return { isEnabled: false };
  const tracer = provider.getTracer("ai.sdk");
  // Cast needed: @ai-sdk/otel was built against a slightly older @ai-sdk/provider-utils
  // than the one ai@7.0.173 pulls in; the runtime interface is identical.
  return { isEnabled: true, tracer, integrations: [new OpenTelemetry({ tracer }) as unknown as Telemetry] };
}
