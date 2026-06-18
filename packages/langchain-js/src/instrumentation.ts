import * as CallbackManagerModule from "@langchain/core/callbacks/manager";
import { LangChainInstrumentation } from "@arizeai/openinference-instrumentation-langchain";
import { getOrCreateAstroTracerProvider, logger } from "@astropods/adapter-core";

let instrumented = false;

/**
 * Wire LangChain tracing to Astro's OTLP exporter. Patches LangChain's shared
 * callback manager process-wide — the only injection point OpenInference
 * exposes. Idempotent; a no-op returning `false` when
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is unset.
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
