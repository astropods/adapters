/**
 * Minimal agent used to smoke-test the AgentCore serving mode of adapter-core
 * WITHOUT Docker or the messaging service. It is the same shape as hello-astro
 * (echo + a canned line), wired through `serve()`.
 *
 * Run it with ASTRO_RUNTIME=agentcore so serve() starts the HTTP server
 * (POST /invocations, GET /ping on :8080) instead of dialing the messaging
 * gRPC service. See docs/local-runbook.md §4.0.
 *
 *   ASTRO_RUNTIME=agentcore PORT=8080 bun examples/agentcore-smoke.ts
 */
import { serve } from "../src/index.js";
import type { AgentAdapter, StreamHooks, StreamOptions } from "../src/index.js";

const adapter: AgentAdapter = {
  name: "AgentCore Smoke",

  async stream(prompt: string, hooks: StreamHooks, _options: StreamOptions): Promise<void> {
    hooks.onChunk(`Echo: ${prompt}\n\n`);
    hooks.onChunk("Here's a line: adapter-core is serving the AgentCore contract.");
    hooks.onFinish();
  },

  getConfig() {
    return { systemPrompt: "Echoes messages.", tools: [] } as unknown as ReturnType<
      AgentAdapter["getConfig"]
    >;
  },
};

serve(adapter);
