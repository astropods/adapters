import { OpenTelemetry } from "@ai-sdk/otel";
import { getOrCreateAstroTracerProvider } from "@astropods/adapter-core";
import type { Tracer } from "@opentelemetry/api";
import type { Telemetry, TelemetryOptions } from "ai";

// AI SDK 6 reads `tracer`; AI SDK 7 ignores it and sends spans only to `integrations`.
export function astroTelemetry(): TelemetryOptions & { tracer?: Tracer } {
  const provider = getOrCreateAstroTracerProvider({ register: false });
  if (!provider) return { isEnabled: false };
  const tracer = provider.getTracer("ai.sdk");
  // @ai-sdk/otel bundles ai as a direct dep so its Telemetry type diverges from
  // the host ai version when provider-utils has a minor type-only bump. The cast
  // is safe: the class declares `implements Telemetry` and the runtime shape is
  // identical.
  return { isEnabled: true, tracer, integrations: [new OpenTelemetry({ tracer }) as unknown as Telemetry] };
}
