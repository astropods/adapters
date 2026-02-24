import type { Agent } from "@mastra/core/agent";
import type {
  AgentConfig as MessagingAgentConfig,
} from "@astropods/messaging";
import type { AgentAdapter, StreamHooks, StreamOptions } from "@astropods/adapter-core";

/**
 * Adapts a Mastra Agent to the Astro messaging protocol.
 *
 * Translates Mastra's fullStream chunk types into the StreamHooks lifecycle
 * that the MessagingBridge expects.
 */
export class MastraAdapter implements AgentAdapter {
  readonly name: string;

  constructor(private agent: Agent) {
    this.name = agent.name;
  }

  async stream(
    prompt: string,
    hooks: StreamHooks,
    options: StreamOptions
  ): Promise<void> {
    const stream = await this.agent.stream(prompt, {
      memory: {
        thread: options.conversationId,
        resource: options.userId,
      },
    });

    // Track tool names by call ID so we can reference them when the call ends
    // (the end chunk only carries toolCallId, not toolName).
    const toolNames = new Map<string, string>();

    for await (const chunk of stream.fullStream) {
      switch (chunk.type) {
        case "text-delta":
          hooks.onChunk(chunk.payload.text);
          break;

        case "reasoning-start":
          hooks.onStatusUpdate({ status: "THINKING" });
          break;

        case "reasoning-end":
          hooks.onStatusUpdate({ status: "GENERATING" });
          break;

        case "tool-call-input-streaming-start":
          toolNames.set(chunk.payload.toolCallId, chunk.payload.toolName);
          hooks.onStatusUpdate({
            status: "PROCESSING",
            customMessage: `Running ${chunk.payload.toolName}`,
          });
          break;

        case "tool-call-input-streaming-end": {
          const toolName = toolNames.get(chunk.payload.toolCallId) ?? "tool";
          toolNames.delete(chunk.payload.toolCallId);
          hooks.onStatusUpdate({
            status: "ANALYZING",
            customMessage: `Finished ${toolName}`,
          });
          break;
        }

        case "finish":
          hooks.onFinish();
          break;

        case "error":
          hooks.onError(
            chunk.payload.error instanceof Error
              ? chunk.payload.error
              : new Error(String(chunk.payload.error))
          );
          break;
      }
    }
  }

  getConfig(): MessagingAgentConfig {
    // getInstructions() is sync when instructions are static strings (the common case).
    // Dynamic instruction functions return a Promise and are skipped here since
    // getConfig() is called once at startup for playground display.
    const instructions = this.agent.getInstructions();
    let systemPrompt = "";
    if (typeof instructions === "string") {
      systemPrompt = instructions;
    } else if (Array.isArray(instructions)) {
      systemPrompt = instructions
        .map((i) => (typeof i === "string" ? i : ""))
        .filter(Boolean)
        .join("\n\n");
    }

    // listTools() is sync when tools are static (the common case).
    const tools = this.agent.listTools();
    let toolConfigs: MessagingAgentConfig["tools"] = [];
    if (tools && typeof tools === "object" && !("then" in tools)) {
      toolConfigs = Object.entries(tools).map(([name, tool]) => ({
        name,
        title: name,
        description:
          (tool as { description?: string }).description || "",
        type: "other",
      }));
    }

    return {
      systemPrompt,
      tools: toolConfigs,
    };
  }
}
