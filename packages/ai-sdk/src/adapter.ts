import type { Agent, ModelMessage, ToolSet } from "ai";
import type { AgentConfig as MessagingAgentConfig } from "@astropods/messaging";
import type {
  AgentAdapter,
  StreamHooks,
  StreamOptions,
} from "@astropods/adapter-core";

export interface AISDKAdapterOptions {
  name?: string;
  /** The AI SDK `Agent` interface exposes no `instructions` field, so accept them here for the playground. */
  instructions?: string;
  /** Turns of history each conversation keeps in process. Defaults to 20. */
  maxTurns?: number;
  /** Serialized size a conversation's history may reach, in bytes. Defaults to 256 KiB, about 64K tokens. */
  maxHistoryBytes?: number;
  /** Conversations kept in process; the least recently used is forgotten first. Defaults to 200. */
  maxConversations?: number;
}

interface Turn {
  messages: ModelMessage[];
  bytes: number;
}

export class AISDKAdapter<TOOLS extends ToolSet = ToolSet>
  implements AgentAdapter
{
  readonly name: string;
  private readonly instructions: string;
  private readonly maxTurns: number;
  private readonly maxHistoryBytes: number;
  private readonly maxConversations: number;
  // Whole turns, so trimming never separates a tool call from its result.
  // Insertion order is recency: a conversation is re-inserted on every turn.
  private readonly conversations = new Map<string, Turn[]>();

  constructor(
    private agent: Agent<never, TOOLS, any>,
    options: AISDKAdapterOptions = {}
  ) {
    this.name = options.name ?? agent.id ?? "AI SDK Agent";
    this.instructions = options.instructions ?? "";
    this.maxTurns = options.maxTurns ?? 20;
    this.maxHistoryBytes = options.maxHistoryBytes ?? 256 * 1024;
    this.maxConversations = options.maxConversations ?? 200;
  }

  async stream(
    prompt: string,
    hooks: StreamHooks,
    options: StreamOptions
  ): Promise<void> {
    const turns = this.conversations.get(options.conversationId) ?? [];
    const ask: ModelMessage = { role: "user", content: prompt };
    const result = await this.agent.stream({
      messages: [...turns.flatMap((t) => t.messages), ask],
      abortSignal: options.signal,
    });
    let failed = false;

    // tool-input-end carries only the call id; track id → name on -start.
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
          failed = true;
          hooks.onError(
            part.error instanceof Error
              ? part.error
              : new Error(String(part.error))
          );
          break;
      }
    }

    if (failed) return;
    const { messages } = await result.response;
    const turn = [ask, ...messages];
    this.remember(options.conversationId, [
      ...turns,
      { messages: turn, bytes: Buffer.byteLength(JSON.stringify(turn)) },
    ]);
  }

  private remember(conversationId: string, turns: Turn[]): void {
    let kept = turns.slice(-this.maxTurns);
    let bytes = kept.reduce((sum, t) => sum + t.bytes, 0);
    while (kept.length > 0 && bytes > this.maxHistoryBytes) {
      bytes -= kept[0].bytes;
      kept = kept.slice(1);
    }
    this.conversations.delete(conversationId);
    this.conversations.set(conversationId, kept);
    for (const oldest of this.conversations.keys()) {
      if (this.conversations.size <= this.maxConversations) break;
      this.conversations.delete(oldest);
    }
  }

  getConfig(): MessagingAgentConfig {
    // An Agent created without a `tools` option has `tools === undefined`,
    // so default to an empty set before enumerating.
    const tools = (this.agent.tools ?? {}) as Record<
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
