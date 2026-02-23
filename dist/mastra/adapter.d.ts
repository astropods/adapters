import type { Agent } from "@mastra/core/agent";
import type { AgentConfig as MessagingAgentConfig } from "@astromode-ai/astro-messaging";
import type { AgentAdapter, StreamHooks, StreamOptions } from "../types";
/**
 * Adapts a Mastra Agent to the Astro messaging protocol.
 *
 * Translates Mastra's fullStream chunk types into the StreamHooks lifecycle
 * that the MessagingBridge expects.
 */
export declare class MastraAdapter implements AgentAdapter {
    private agent;
    readonly name: string;
    constructor(agent: Agent);
    stream(prompt: string, hooks: StreamHooks, options: StreamOptions): Promise<void>;
    getConfig(): MessagingAgentConfig;
}
//# sourceMappingURL=adapter.d.ts.map