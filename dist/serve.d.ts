import type { AgentAdapter, ServeOptions } from "./types";
/**
 * Connect an agent adapter to the Astro messaging service and start listening.
 *
 * This is the framework-agnostic entry point. For Mastra agents, prefer the
 * convenience `serve()` from `@saswatds/astro-agent-adapters/mastra` which
 * accepts a Mastra Agent directly.
 */
export declare function serve(adapter: AgentAdapter, options?: ServeOptions): void;
//# sourceMappingURL=serve.d.ts.map