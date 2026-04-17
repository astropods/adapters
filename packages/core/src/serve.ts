import { MessagingBridge } from "./messaging-bridge";
import type { AgentAdapter, ServeOptions } from "./types";
import { logger } from "./logger";

/**
 * Connect an agent adapter to the Astro messaging service and start listening.
 *
 * This is the framework-agnostic entry point. For Mastra agents, prefer the
 * convenience `serve()` from `@astropods/adapter-mastra` which
 * accepts a Mastra Agent directly.
 */
export function serve(adapter: AgentAdapter, options?: ServeOptions): void {
  const bridge = new MessagingBridge(adapter, options);
  bridge.start().catch((error) => {
    logger.error({ err: error }, "Fatal error");
    process.exit(1);
  });
}
