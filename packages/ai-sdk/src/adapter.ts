import type { Agent, ToolSet } from "ai";
import type { AgentConfig as MessagingAgentConfig } from "@astropods/messaging";
import type {
  AgentAdapter,
  StreamHooks,
  StreamOptions,
} from "@astropods/adapter-core";

export interface AISDKAdapterOptions {
  /** Display name shown in logs and the playground. Defaults to `agent.id`, then "AI SDK Agent". */
  name?: string;
  /** System prompt shown in the playground. The AI SDK `Agent` interface does not expose
   *  instructions, so they must be passed explicitly to surface in the playground. */
  instructions?: string;
}

/**
 * Adapts a Vercel AI SDK `Agent` (e.g. `ToolLoopAgent` / `Experimental_Agent`)
 * to the Astro messaging protocol. Translates the AI SDK `fullStream` event
 * types into the `StreamHooks` lifecycle.
 */
export class AISDKAdapter<TOOLS extends ToolSet = ToolSet>
  implements AgentAdapter
{
  readonly name: string;
  private readonly instructions: string;

  constructor(
    private agent: Agent<never, TOOLS, any>,
    options: AISDKAdapterOptions = {}
  ) {
    this.name = options.name ?? agent.id ?? "AI SDK Agent";
    this.instructions = options.instructions ?? "";
  }

  async stream(
    prompt: string,
    hooks: StreamHooks,
    _options: StreamOptions
  ): Promise<void> {
    const result = await this.agent.stream({ prompt });

    // tool-input-end only carries the call id; track id → name on -start.
    const toolNames = new Map<string, string>();

    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta":
          hooks.onChunk(part.text);
          break;

        case "reasoning-start":
          hooks.onStatusUpdate({ status: "THINKING" });
          break;

        case "reasoning-end":
          hooks.onStatusUpdate({ status: "GENERATING" });
          break;

        case "tool-input-start":
          toolNames.set(part.id, part.toolName);
          hooks.onStatusUpdate({
            status: "PROCESSING",
            customMessage: `Running ${part.toolName}`,
          });
          break;

        case "tool-input-end": {
          const toolName = toolNames.get(part.id) ?? "tool";
          toolNames.delete(part.id);
          hooks.onStatusUpdate({
            status: "ANALYZING",
            customMessage: `Finished ${toolName}`,
          });
          break;
        }

        case "tool-error":
          hooks.onError(
            part.error instanceof Error
              ? part.error
              : new Error(String(part.error))
          );
          break;

        case "finish":
          hooks.onFinish();
          break;

        case "error":
          hooks.onError(
            part.error instanceof Error
              ? part.error
              : new Error(String(part.error))
          );
          break;
      }
    }
  }

  getConfig(): MessagingAgentConfig {
    const tools = this.agent.tools as Record<
      string,
      { description?: string; title?: string }
    >;

    const toolConfigs: MessagingAgentConfig["tools"] = Object.entries(tools).map(
      ([name, tool]) => ({
        name,
        title: tool.title ?? name,
        description: tool.description ?? "",
        type: "other",
      })
    );

    return {
      systemPrompt: this.instructions,
      tools: toolConfigs,
    };
  }
}
