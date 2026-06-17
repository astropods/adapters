import * as CallbackManagerModule from "@langchain/core/callbacks/manager";
import { LangChainInstrumentation } from "@arizeai/openinference-instrumentation-langchain";
import { getOrCreateAstroTracerProvider, logger } from "@astropods/adapter-core";

let instrumented = false;

/**
 * Enable OpenTelemetry tracing for LangChain, wired to Astro's OTLP exporter.
 *
 * OpenInference only exposes instrumentation through LangChain's shared
 * callback manager, so this patches it process-wide: every LangChain/LangGraph
 * run in the process emits spans (chains, model calls, tools). This is an
 * explicit, opt-in call — nothing is patched on import.
 *
 * Returns `false` when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset (local dev), in
 * which case it is a no-op. Idempotent: calling it more than once instruments
 * the callback manager exactly once.
 */
export function instrumentLangChain(): boolean {
  if (instrumented) return true;

  const provider = getOrCreateAstroTracerProvider();
  if (!provider) return false;

  const instrumentation = new LangChainInstrumentation();
  instrumentation.setTracerProvider(provider);
  instrumentation.manuallyInstrument(CallbackManagerModule);

  instrumented = true;
  logger.info("LangChain instrumentation enabled (process-global)");
  return true;
}
