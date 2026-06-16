import type { Agent, ToolSet } from "ai";
import { serve as serveAdapter } from "@astropods/adapter-core";
import type { ServeOptions } from "@astropods/adapter-core";
import { AISDKAdapter } from "./adapter";
import type { AISDKAdapterOptions } from "./adapter";

export { AISDKAdapter } from "./adapter";
export type { AISDKAdapterOptions } from "./adapter";
export { astroTelemetry } from "./telemetry";

export function serve<TOOLS extends ToolSet = ToolSet>(
  agent: Agent<never, TOOLS, any>,
  options: AISDKAdapterOptions & ServeOptions = {}
): void {
  const adapter = new AISDKAdapter(agent, options);
  serveAdapter(adapter, options);
}
