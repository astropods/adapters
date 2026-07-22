import { MessagingBridge } from "./messaging-bridge.js";
import type { AgentAdapter, ServeOptions } from "./types.js";
import { logger } from "./logger.js";

/**
 * Connect an agent adapter to the Astro messaging service and start listening.
 *
 * This is the framework-agnostic entry point. For Mastra agents, prefer the
 * convenience `serve()` from `@astropods/adapter-mastra` which
 * accepts a Mastra Agent directly.
 *
 * When `ASTRO_RUNTIME=agentcore` is set, the adapter is instead served over the
 * AWS Bedrock AgentCore Runtime HTTP contract (`POST /invocations`, `GET /ping`
 * on :8080) — the invoke-per-turn transport. The default (unset) behavior is
 * unchanged: dial the messaging gRPC service and hold a bidirectional stream.
 */
export function serve(adapter: AgentAdapter, options?: ServeOptions): void {
  const fail = (error: unknown) => {
    logger.error({ err: error }, "Fatal error");
    process.exit(1);
  };

  // Opt-in AgentCore Runtime mode. Dynamically imported so the default (gRPC)
  // path's dependency graph is untouched when the flag is unset.
  if (process.env.ASTRO_RUNTIME === "agentcore") {
    import("./agentcore-server.js")
      .then(({ AgentCoreServer }) => new AgentCoreServer(adapter, options).start())
      .catch(fail);
    return;
  }

  const bridge = new MessagingBridge(adapter, options);
  bridge.start().catch(fail);
}
