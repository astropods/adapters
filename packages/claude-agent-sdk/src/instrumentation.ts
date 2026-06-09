import { getOrCreateAstroTracerProvider } from "@astropods/adapter-core";
import { ClaudeAgentSDKInstrumentation } from "@arizeai/openinference-instrumentation-claude-agent-sdk";

/**
 * Replaces `sdk.query` with the OpenInference-instrumented version, wired
 * to the shared OTel tracer provider. Returns `false` when
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is unset.
 */
export function instrumentSDK(sdk: Record<string, any>): boolean {
  const provider = getOrCreateAstroTracerProvider();
  if (!provider) return false;

  const instrumentation = new ClaudeAgentSDKInstrumentation();
  instrumentation.setTracerProvider(provider);
  instrumentation.manuallyInstrument(sdk);

  return true;
}
