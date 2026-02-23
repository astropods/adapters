import type { Agent } from "@mastra/core/agent";
import type { ServeOptions } from "../types";
export { MastraAdapter } from "./adapter";
/**
 * Connect a Mastra Agent to the Astro messaging service and start listening.
 *
 * ```typescript
 * import { Agent } from '@mastra/core/agent';
 * import { serve } from '@astromode-ai/astro-agent-adapters/mastra';
 *
 * const agent = new Agent({
 *   name: 'My Agent',
 *   model: 'openai/gpt-4o',
 *   instructions: 'You are a helpful assistant.',
 * });
 *
 * serve(agent);
 * ```
 */
export declare function serve(agent: Agent, options?: ServeOptions): void;
//# sourceMappingURL=index.d.ts.map