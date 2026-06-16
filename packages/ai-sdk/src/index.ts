import type { Agent, ToolSet } from "ai";
import { serve as serveAdapter } from "@astropods/adapter-core";
import type { ServeOptions } from "@astropods/adapter-core";
import { AISDKAdapter } from "./adapter";
import type { AISDKAdapterOptions } from "./adapter";
import { setupObservability } from "./observability";

export { AISDKAdapter } from "./adapter";
export type { AISDKAdapterOptions } from "./adapter";

/**
 * Connect a Vercel AI SDK `Agent` to the Astro messaging service and start
 * listening.
 *
 * When `OTEL_EXPORTER_OTLP_ENDPOINT` is set, the OpenTelemetry global tracer
 * provider is registered automatically. The AI SDK only emits spans when the
 * agent is constructed with `experimental_telemetry: { isEnabled: true }`,
 * so opt in there.
 *
 * ```typescript
 * import { Experimental_Agent as Agent } from 'ai';
 * import { openai } from '@ai-sdk/openai';
 * import { serve } from '@astropods/adapter-ai-sdk';
 *
 * const instructions = 'You are a helpful assistant.';
 * const agent = new Agent({
 *   model: openai('gpt-4o'),
 *   instructions,
 *   experimental_telemetry: { isEnabled: true },
 * });
 *
 * serve(agent, { name: 'My Agent', instructions });
 * ```
 */
export function serve<TOOLS extends ToolSet = ToolSet>(
  agent: Agent<never, TOOLS, any>,
  options: AISDKAdapterOptions & ServeOptions = {}
): void {
  setupObservability();
  const adapter = new AISDKAdapter(agent, options);
  serveAdapter(adapter, options);
}
