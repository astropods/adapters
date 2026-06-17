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
  /** Instrument LangChain before serving. Defaults to `true`. */
  instrument?: boolean;
}

/** Serve a LangChain/LangGraph agent over Astro messaging; instruments by default. */
export function serve(
  agent: LangChainAgent,
  options: LangChainServeOptions = {}
): void {
  if (options.instrument !== false) instrumentLangChain();
  const adapter = new LangChainAdapter(agent, options);
  serveAdapter(adapter, options);
}
