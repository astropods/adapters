import { trace, SpanStatusCode } from "@opentelemetry/api";
import type {
  AgentConfig as MessagingAgentConfig,
  AgentToolConfig,
} from "@astropods/messaging";
import type {
  AgentAdapter,
  StreamHooks,
  StreamOptions,
} from "@astropods/adapter-core";

const tracer = trace.getTracer("@astropods/adapter-langchain");

/** Node names that carry the assistant's own messages / tool calls. */
const MODEL_NODE_KEYS = ["model", "agent"] as const;

/**
 * Structural shape of a compiled LangChain/LangGraph agent — the object
 * returned by `createAgent` (langchain) or `createReactAgent`
 * (@langchain/langgraph). We only depend on `.stream`, so any agent that
 * streams LangGraph state updates works.
 */
export interface LangChainAgent {
  stream(
    input: { messages: Array<{ role: string; content: string }> },
    options?: Record<string, unknown>
  ): Promise<AsyncIterable<unknown>>;
}

/** A tool as constructed for LangChain (`tool()` / `StructuredTool`). */
interface LangChainTool {
  name?: string;
  description?: string;
}

export interface LangChainAdapterOptions {
  /** Display name shown in logs and the playground. Defaults to "LangChain Agent". */
  name?: string;
  /**
   * System prompt shown in the playground. The compiled graph does not expose
   * the prompt, so pass it here to surface it. Optional.
   */
  instructions?: string;
  /**
   * The tools passed to the agent, used only to populate the playground's tool
   * list. The compiled graph does not expose its tools, so pass the same array
   * here. Optional.
   */
  tools?: LangChainTool[];
}

export class LangChainAdapter implements AgentAdapter {
  readonly name: string;
  private readonly instructions: string;
  private readonly tools: LangChainTool[];

  constructor(
    private agent: LangChainAgent,
    options: LangChainAdapterOptions = {}
  ) {
    this.name = options.name ?? "LangChain Agent";
    this.instructions = options.instructions ?? "";
    this.tools = options.tools ?? [];
  }

  async stream(
    prompt: string,
    hooks: StreamHooks,
    options: StreamOptions
  ): Promise<void> {
    // Wrap the run in a span carrying user/session attribution and trace-level
    // input/output. OpenInference's chain/model/tool spans nest under it (the
    // agent runs inside this active span), so the dashboard gets a fully
    // attributed trace with rich child observations. When instrumentation is
    // off this resolves to a no-op span.
    await tracer.startActiveSpan(this.name, async (span) => {
      span.setAttribute("langfuse.user.id", options.userId || "anonymous");
      span.setAttribute("langfuse.session.id", options.conversationId);
      span.setAttribute("langfuse.trace.input", prompt);

      try {
        const output = await this.runStream(prompt, hooks, options);
        span.setAttribute("langfuse.trace.output", output);
        hooks.onFinish();
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        hooks.onError(error);
      } finally {
        span.end();
      }
    });
  }

  /**
   * Drive the LangGraph stream and return the accumulated assistant text.
   * Uses `["messages", "updates"]` so we get token-level text from the model
   * node and tool-call/tool-result lifecycle from state updates.
   */
  private async runStream(
    prompt: string,
    hooks: StreamHooks,
    options: StreamOptions
  ): Promise<string> {
    const stream = await this.agent.stream(
      { messages: [{ role: "user", content: prompt }] },
      {
        streamMode: ["messages", "updates"],
        configurable: { thread_id: options.conversationId },
      }
    );

    let output = "";
    let thinking = false;

    for await (const event of stream as AsyncIterable<[string, unknown]>) {
      const [mode, payload] = event;

      if (mode === "messages") {
        // payload is [messageChunk, metadata]; only the assistant's own
        // messages should surface as chat text (tool results also stream here).
        const [message] = payload as [unknown, unknown];
        if (messageType(message) !== "ai") continue;

        for (const block of contentBlocks(message)) {
          if (block.type === "reasoning") {
            if (!thinking) {
              thinking = true;
              hooks.onStatusUpdate({ status: "THINKING" });
            }
          } else if (block.type === "text" && block.text) {
            if (thinking) {
              thinking = false;
              hooks.onStatusUpdate({ status: "GENERATING" });
            }
            output += block.text;
            hooks.onChunk(block.text);
          }
        }
      } else if (mode === "updates") {
        emitToolStatus(payload as Record<string, NodeUpdate>, hooks);
      }
    }

    return output;
  }

  getConfig(): MessagingAgentConfig {
    const tools: AgentToolConfig[] = this.tools.map((tool) => ({
      name: tool.name ?? "tool",
      title: tool.name ?? "tool",
      description: tool.description ?? "",
      type: "other",
    }));

    return {
      systemPrompt: this.instructions,
      tools,
    };
  }
}

interface NodeUpdate {
  messages?: Array<{ name?: string; tool_calls?: Array<{ name?: string }> }>;
}

/** Map LangGraph state updates to PROCESSING (tool call) / ANALYZING (result) statuses. */
function emitToolStatus(
  update: Record<string, NodeUpdate>,
  hooks: StreamHooks
): void {
  const modelKey = MODEL_NODE_KEYS.find((key) => key in update);
  if (modelKey) {
    for (const message of update[modelKey]?.messages ?? []) {
      for (const call of message.tool_calls ?? []) {
        hooks.onStatusUpdate({
          status: "PROCESSING",
          customMessage: `Running ${call.name ?? "tool"}`,
        });
      }
    }
  }

  for (const message of update.tools?.messages ?? []) {
    hooks.onStatusUpdate({
      status: "ANALYZING",
      customMessage: `Finished ${message.name ?? "tool"}`,
    });
  }
}

interface ContentBlock {
  type: string;
  text?: string;
}

/**
 * Normalize a LangChain message into content blocks. LangChain v1 exposes
 * `contentBlocks`; fall back to raw `content` (string for OpenAI-style,
 * array of blocks for Anthropic-style) for resilience across versions.
 */
function contentBlocks(message: unknown): ContentBlock[] {
  const msg = message as {
    contentBlocks?: ContentBlock[];
    content?: string | Array<string | ContentBlock>;
  };

  if (Array.isArray(msg?.contentBlocks)) return msg.contentBlocks;

  const content = msg?.content;
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (Array.isArray(content)) {
    return content.map((block) =>
      typeof block === "string" ? { type: "text", text: block } : block
    );
  }
  return [];
}

/** LangChain message type discriminator ("ai" | "human" | "tool" | "system"). */
function messageType(message: unknown): string | undefined {
  const msg = message as {
    _getType?: () => string;
    getType?: () => string;
    type?: string;
    role?: string;
  };
  if (typeof msg?._getType === "function") return msg._getType();
  if (typeof msg?.getType === "function") return msg.getType();
  return msg?.type ?? msg?.role;
}
