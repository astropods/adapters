import { MessagingBridge } from "./messaging-bridge";
/**
 * Connect an agent adapter to the Astro messaging service and start listening.
 *
 * This is the framework-agnostic entry point. For Mastra agents, prefer the
 * convenience `serve()` from `@saswatds/astro-agent-adapters/mastra` which
 * accepts a Mastra Agent directly.
 */
export function serve(adapter, options) {
    const bridge = new MessagingBridge(adapter, options);
    bridge.start().catch((error) => {
        console.error("Fatal error:", error);
        process.exit(1);
    });
}
//# sourceMappingURL=serve.js.map