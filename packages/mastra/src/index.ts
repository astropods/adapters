import type { Agent } from "@mastra/core/agent";
import { serve as serveAdapter } from "@astropods/adapter-core";
import type { ServeOptions } from "@astropods/adapter-core";
import { MastraAdapter } from "./adapter";
import type { MastraAdapterOptions } from "./adapter";
import { setupObservability } from "./observability";

export { MastraAdapter } from "./adapter";
export type { MastraAdapterOptions } from "./adapter";

/**
 * Connect a Mastra Agent to the Astro messaging service and start listening.
 *
 * When the `OTEL_EXPORTER_OTLP_ENDPOINT` environment variable is set,
 * OTEL tracing is automatically configured via `@mastra/observability`.
 *
 * ```typescript
 * import { Agent } from '@mastra/core/agent';
 * import { serve } from '@astropods/adapter-mastra';
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
export function serve(
  agent: Agent,
  options?: ServeOptions & MastraAdapterOptions
): void {
  setupObservability(agent);
  const adapter = new MastraAdapter(agent, {
    supportsFiles: options?.supportsFiles,
  });
  serveAdapter(adapter, options);
}
