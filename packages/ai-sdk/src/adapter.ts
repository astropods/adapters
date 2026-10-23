import type { Agent, ModelMessage, ToolSet } from "ai";
import type { AgentConfig as MessagingAgentConfig } from "@astropods/messaging";
import type {
  AgentAdapter,
  AgentConfig,
  StreamHooks,
  StreamOptions,
} from "@astropods/adapter-core";
import { withActorContext, ANONYMOUS_ACTOR_KEY } from "@astropods/adapter-core";

import { ConversationHistory } from "./history";

export interface AISDKAdapterOptions<CALL_OPTIONS = never> {
  name?: string;
  /** The AI SDK `Agent` interface exposes no `instructions` field, so accept them here for the playground. */
  instructions?: string;
  /**
   * Builds the agent's call options for each turn, for an agent declared with
   * `callOptionsSchema`. Its `prepareCall` receives them, which is how the
   * agent reads per-turn context such as `userName`.
   */
  callOptions?: (options: StreamOptions) => CALL_OPTIONS;
  /** Send each conversation's earlier turns to the model as `messages`. Defaults to `true`; `false` sends only `prompt`. */
  memory?: boolean;
  /** Turns of history each conversation keeps. Defaults to 20. */
  maxTurns?: number;
  /** Serialized size a conversation's history may reach, in bytes. Defaults to 256 KiB, about 64K tokens. */
  maxHistoryBytes?: number;
  /** Conversations kept in process; the least recently used is forgotten first. Defaults to 200. */
  maxConversations?: number;
}

export class AISDKAdapter<TOOLS extends ToolSet = ToolSet, CALL_OPTIONS = never>
  implements AgentAdapter
{
  readonly name: string;
  private readonly instructions: string;
  private readonly callOptions?: (options: StreamOptions) => CALL_OPTIONS;
  private readonly history: ConversationHistory | undefined;

  constructor(
    private agent: Agent<CALL_OPTIONS, TOOLS, any>,
    options: AISDKAdapterOptions<CALL_OPTIONS> = {}
  ) {
    this.name = options.name ?? agent.id ?? "AI SDK Agent";
    this.instructions = options.instructions ?? "";
    this.callOptions = options.callOptions;
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
    if (history && options.history) {
      history.replace(
        conversationId,
        options.history.messages.map(({ role, content }) => ({ role, content }) as ModelMessage)
      );
    }
    // Active for the whole turn, so a gateway call this agent makes
    // attributes its cost to this actor instead of landing as an
    // account-wide, unattributed total — see billed-vs-estimated-cost-spec.md,
    // "Telling gateway traffic apart, and merging it". The AI Gateway
    // client that actually reads this (createOpenAI({ fetch:
    // withActorHeaders() }) in the scaffold template) picks it up through
    // withActorHeaders.
    return withActorContext({ actorKey: options.userId || ANONYMOUS_ACTOR_KEY }, () =>
      this.runStream(prompt, hooks, options, conversationId, history)
    );
  }

  private async runStream(
    prompt: string,
    hooks: StreamHooks,
    options: StreamOptions,
    conversationId: string,
    history: ConversationHistory | undefined
  ): Promise<void> {
    const ask: ModelMessage = { role: "user", content: prompt };
    let failed = false;
    let aborted = false;

    try {
      const input = history
        ? { messages: [...history.messages(conversationId), ask], abortSignal: options.signal }
        : { prompt, abortSignal: options.signal };
      // `options` is required or forbidden depending on CALL_OPTIONS, which a
      // generic class cannot narrow.
      const result = await this.agent.stream(
        (this.callOptions ? { ...input, options: this.callOptions(options) } : input) as Parameters<
          Agent<CALL_OPTIONS, TOOLS, any>["stream"]
        >[0]
      );
      // Rejects after an abort or an error, on paths that never await it.
      const turnMessages = responseMessages(result);
      turnMessages.catch(() => {});

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
      history.append(conversationId, [ask, ...(await turnMessages)]);
    } catch (err) {
      if (history && !options.signal?.aborted) history.shrink(conversationId);
      throw err;
    }
  }

  getConfig(): AgentConfig {
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
      // With memory off the agent keeps its own, which the adapter cannot reset.
      supportsHistory: this.history !== undefined,
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
