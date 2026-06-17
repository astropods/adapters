import { serve as serveAdapter } from "@astropods/adapter-core";
import type { ServeOptions } from "@astropods/adapter-core";
import { LangChainAdapter } from "./adapter";
import type { LangChainAgent, LangChainAdapterOptions } from "./adapter";
import { instrumentLangChain } from "./instrumentation";

export { LangChainAdapter } from "./adapter";
export type { LangChainAgent, LangChainAdapterOptions } from "./adapter";
export { instrumentLangChain } from "./instrumentation";

export interface LangChainServeOptions
  extends LangChainAdapterOptions,
    ServeOptions {
  /**
   * Enable process-global OpenTelemetry instrumentation before serving.
   * Defaults to `true`. Set to `false` to manage instrumentation yourself
   * (or to skip it entirely).
   */
  instrument?: boolean;
}

/**
 * Connect a LangChain/LangGraph agent to the Astro messaging service and start
 * listening. Instruments LangChain by default; pass `{ instrument: false }` to
 * opt out.
 */
export function serve(
  agent: LangChainAgent,
  options: LangChainServeOptions = {}
): void {
  if (options.instrument !== false) instrumentLangChain();
  const adapter = new LangChainAdapter(agent, options);
  serveAdapter(adapter, options);
}
