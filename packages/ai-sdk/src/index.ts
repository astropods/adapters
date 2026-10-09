import type { Agent, ToolSet } from "ai";
import { serve as serveAdapter } from "@astropods/adapter-core";
import type { ServeOptions } from "@astropods/adapter-core";
import { AISDKAdapter } from "./adapter";
import type { AISDKAdapterOptions } from "./adapter";

export { AISDKAdapter } from "./adapter";
export type { AISDKAdapterOptions } from "./adapter";
export { astroTelemetry } from "./telemetry";

export function serve<TOOLS extends ToolSet = ToolSet, CALL_OPTIONS = never>(
  agent: Agent<CALL_OPTIONS, TOOLS, any>,
  options: AISDKAdapterOptions<CALL_OPTIONS> & ServeOptions = {}
): void {
  const adapter = new AISDKAdapter(agent, options);
  serveAdapter(adapter, options);
}
