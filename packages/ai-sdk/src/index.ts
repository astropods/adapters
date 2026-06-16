import type { Agent, ToolSet } from "ai";
import { serve as serveAdapter } from "@astropods/adapter-core";
import type { ServeOptions } from "@astropods/adapter-core";
import { AISDKAdapter } from "./adapter";
import type { AISDKAdapterOptions } from "./adapter";

export { AISDKAdapter } from "./adapter";
export type { AISDKAdapterOptions } from "./adapter";
export { astroTelemetry } from "./telemetry";

/**
 * Connect a Vercel AI SDK `Agent` to the Astro messaging service and start
 * listening.
 *
 * Observability is opt-in and explicit: pass `astroTelemetry()` into the
 * agent's `experimental_telemetry` to route OpenTelemetry spans to Astro
 * without touching the OTel global tracer provider.
 *
 * ```typescript
 * import { Experimental_Agent as Agent } from 'ai';
 * import { openai } from '@ai-sdk/openai';
 * import { serve, astroTelemetry } from '@astropods/adapter-ai-sdk';
 *
 * const instructions = 'You are a helpful assistant.';
 * const agent = new Agent({
 *   model: openai('gpt-4o'),
 *   instructions,
 *   experimental_telemetry: astroTelemetry(),
 * });
 *
 * serve(agent, { name: 'My Agent', instructions });
 * ```
 */
export function serve<TOOLS extends ToolSet = ToolSet>(
  agent: Agent<never, TOOLS, any>,
  options: AISDKAdapterOptions & ServeOptions = {}
): void {
  const adapter = new AISDKAdapter(agent, options);
  serveAdapter(adapter, options);
}
