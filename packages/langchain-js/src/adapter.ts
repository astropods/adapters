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

// "model" (createAgent) and "agent" (createReactAgent).
const MODEL_NODE_KEYS = ["model", "agent"] as const;

/** Minimal surface used from a compiled agent (`createAgent` / `createReactAgent`). */
export interface LangChainAgent {
  stream(
    input: { messages: Array<{ role: string; content: string }> },
    options?: Record<string, unknown>
  ): Promise<AsyncIterable<unknown>>;
}

interface LangChainTool {
  name?: string;
  description?: string;
}

export interface LangChainAdapterOptions {
  /** Defaults to "LangChain Agent". */
  name?: string;
  /**
   * System prompt shown in the playground. Read automatically from
   * `agent.options.systemPrompt` for `createAgent` agents; set this to override
   * it, or to supply it for agents that don't expose it (e.g. raw compiled
   * graphs).
   */
  instructions?: string;
  /**
   * Tools shown in the playground's tool list. Read automatically from
   * `agent.options.tools` for `createAgent` agents; set this to override.
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
    const derived = deriveAgentMetadata(agent);
    this.name = options.name ?? "LangChain Agent";
    this.instructions = options.instructions ?? derived.instructions;
    this.tools = options.tools ?? derived.tools;
  }

  async stream(
    prompt: string,
    hooks: StreamHooks,
    options: StreamOptions
  ): Promise<void> {
    // Root span carrying user/session + trace IO. OpenInference's spans nest
    // under it via the active context; a no-op span when uninstrumented.
    await tracer.startActiveSpan(this.name, async (span) => {
      span.setAttribute("langfuse.user.id", options.userId || "anonymous");
      span.setAttribute("langfuse.session.id", options.conversationId);
      span.setAttribute("langfuse.trace.input", prompt);

      try {
        const output = await this.runStream(prompt, hooks, options);
        span.setAttribute("langfuse.trace.output", output);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        hooks.onError(error);
        return;
      } finally {
        span.end();
      }

      // Only on success — onError already terminated the response on failure.
      hooks.onFinish();
    });
  }

  private async runStream(
    prompt: string,
    hooks: StreamHooks,
    options: StreamOptions
  ): Promise<string> {
    // messages → token-level assistant text; updates → tool call/result lifecycle.
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
        // [messageChunk, metadata]; tool/human messages stream here too — skip them.
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

// v1 exposes contentBlocks; fall back to raw content (string or block array).
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

function messageType(message: unknown): string | undefined {
  const msg = message as {
    _getType?: () => string;
    getType?: () => string;
    type?: string;
    role?: string;
  };
  if (typeof msg?.getType === "function") return msg.getType();
  if (typeof msg?._getType === "function") return msg._getType();
  return msg?.type ?? msg?.role;
}

/** `createAgent` returns a ReactAgent that retains its construction options. */
interface ReactAgentOptions {
  systemPrompt?: unknown;
  tools?: LangChainTool[];
}

// Reuse the prompt and tools createAgent already holds, so callers don't
// re-declare what they passed to createAgent. Raw compiled graphs don't expose
// `options`; their playground metadata comes from the adapter options instead.
function deriveAgentMetadata(agent: LangChainAgent): {
  instructions: string;
  tools: LangChainTool[];
} {
  const options = (agent as { options?: ReactAgentOptions }).options;
  return {
    instructions: systemPromptText(options?.systemPrompt),
    tools: options?.tools ?? [],
  };
}

// systemPrompt is a string or a SystemMessage, whose `text` getter flattens its
// content blocks to a string.
function systemPromptText(prompt: unknown): string {
  if (typeof prompt === "string") return prompt;
  if (prompt && typeof prompt === "object") {
    const text = (prompt as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return "";
}
