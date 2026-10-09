import type { Agent, ModelMessage, ToolSet } from "ai";
import type { AgentConfig as MessagingAgentConfig } from "@astropods/messaging";
import type {
  AgentAdapter,
  StreamHooks,
  StreamOptions,
} from "@astropods/adapter-core";

import { ConversationHistory } from "./history";

export interface AISDKAdapterOptions {
  name?: string;
  /** The AI SDK `Agent` interface exposes no `instructions` field, so accept them here for the playground. */
  instructions?: string;
  /** Send each conversation's earlier turns to the model as `messages`. Defaults to `true`; `false` sends only `prompt`. */
  memory?: boolean;
  /** Turns of history each conversation keeps. Defaults to 20. */
  maxTurns?: number;
  /** Serialized size a conversation's history may reach, in bytes. Defaults to 256 KiB, about 64K tokens. */
  maxHistoryBytes?: number;
  /** Conversations kept in process; the least recently used is forgotten first. Defaults to 200. */
  maxConversations?: number;
}

export class AISDKAdapter<TOOLS extends ToolSet = ToolSet>
  implements AgentAdapter
{
  readonly name: string;
  private readonly instructions: string;
  private readonly history: ConversationHistory | undefined;

  constructor(
    private agent: Agent<never, TOOLS, any>,
    options: AISDKAdapterOptions = {}
  ) {
    this.name = options.name ?? agent.id ?? "AI SDK Agent";
    this.instructions = options.instructions ?? "";
    const history = new ConversationHistory({
      maxTurns: options.maxTurns ?? 20,
      maxHistoryBytes: options.maxHistoryBytes ?? 256 * 1024,
      maxConversations: options.maxConversations ?? 200,
    });
    this.history = options.memory !== false && history.enabled ? history : undefined;
  }

  async stream(
    prompt: string,
    hooks: StreamHooks,
    options: StreamOptions
  ): Promise<void> {
    const conversationId = options.conversationId;
    const history = conversationId ? this.history : undefined;
    const ask: ModelMessage = { role: "user", content: prompt };
    let failed = false;
    let aborted = false;

    try {
      const result = await this.agent.stream(
        history
          ? { messages: [...history.messages(conversationId), ask], abortSignal: options.signal }
          : { prompt, abortSignal: options.signal }
      );

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

          case "abort":
            aborted = true;
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

      if (!history) return;
      if (aborted || options.signal?.aborted) return;
      if (failed) {
        history.shrink(conversationId);
        return;
      }
      history.append(conversationId, [ask, ...(await responseMessages(result))]);
    } catch (err) {
      if (history && !options.signal?.aborted) history.shrink(conversationId);
      throw err;
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

/** Every step's messages. `responseMessages` exists from ai 7; on 6, `response.messages` holds them. */
async function responseMessages(result: object): Promise<ModelMessage[]> {
  if ("responseMessages" in result) {
    return await (result as { responseMessages: PromiseLike<ModelMessage[]> }).responseMessages;
  }
  return (await (result as { response: PromiseLike<{ messages: ModelMessage[] }> }).response).messages;
}
