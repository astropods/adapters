import type { Agent } from "@mastra/core/agent";
import { serve as serveAdapter } from "@astropods/adapter-core";
import type { ServeOptions } from "@astropods/adapter-core";
import { MastraAdapter } from "./adapter";

export { MastraAdapter } from "./adapter";

/**
 * Connect a Mastra Agent to the Astro messaging service and start listening.
 *
 * ```typescript
 * import { Agent } from '@mastra/core/agent';
 * import { serve } from '@astromode-ai/adapter-mastra';
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
export function serve(agent: Agent, options?: ServeOptions): void {
  const adapter = new MastraAdapter(agent);
  serveAdapter(adapter, options);
}
