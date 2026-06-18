import { serve as serveAdapter, logger } from "@astropods/adapter-core";
import type { ServeOptions } from "@astropods/adapter-core";
import { LangChainAdapter } from "./adapter";
import type { LangChainAgent, LangChainAdapterOptions } from "./adapter";
import { instrumentLangChain } from "./instrumentation";
import { ensureCheckpointer } from "./memory";

export { LangChainAdapter } from "./adapter";
export type { LangChainAgent, LangChainAdapterOptions } from "./adapter";
export { instrumentLangChain } from "./instrumentation";
export { ensureCheckpointer } from "./memory";

export interface LangChainServeOptions
  extends LangChainAdapterOptions,
    ServeOptions {
  /** Instrument LangChain before serving. Defaults to `true`. */
  instrument?: boolean;
  /**
   * Install an in-process MemorySaver when the agent has no checkpointer, so
   * conversations remember prior turns. Defaults to `true`. A durable
   * checkpointer configured on the agent is always respected.
   */
  memory?: boolean;
}

/** Serve a LangChain/LangGraph agent over Astro messaging; instruments by default. */
export function serve(
  agent: LangChainAgent,
  options: LangChainServeOptions = {}
): void {
  if (options.instrument !== false) instrumentLangChain();

  const start = () => serveAdapter(new LangChainAdapter(agent, options), options);

  if (options.memory === false) {
    start();
    return;
  }

  // Install in-memory persistence before the bridge starts taking messages.
  void ensureCheckpointer(agent).then((installed) => {
    if (installed) {
      logger.info("No checkpointer configured; using an in-process MemorySaver");
    }
    start();
  });
}
