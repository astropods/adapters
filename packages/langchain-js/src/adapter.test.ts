import { describe, test, expect } from "bun:test";
import type { StatusUpdate } from "@astropods/messaging";
import type { StreamOptions } from "@astropods/adapter-core";

import { LangChainAdapter } from "./adapter";
import type { LangChainAgent } from "./adapter";

function createHooks() {
  const result = {
    chunks: [] as string[],
    statuses: [] as StatusUpdate[],
    errors: [] as Error[],
    finishCount: 0,
    onChunk(text: string) {
      result.chunks.push(text);
    },
    onStatusUpdate(status: StatusUpdate) {
      result.statuses.push(status);
    },
    onError(error: Error) {
      result.errors.push(error);
    },
    onFinish() {
      result.finishCount++;
    },
    onTranscript() {},
    onAudioChunk() {},
    onAudioEnd() {},
  };
  return result;
}

const defaultOptions: StreamOptions = {
  conversationId: "conv-1",
  userId: "user-1",
};

async function* asyncFrom<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

/** Build an AI message chunk with the given content blocks. */
function aiMessage(blocks: Array<{ type: string; text?: string }>): unknown {
  return { _getType: () => "ai", contentBlocks: blocks };
}

/** Build a fake compiled agent that yields the given [mode, payload] tuples. */
function fakeAgent(
  tuples: Array<[string, unknown]>,
  opts: { throwOnStream?: boolean } = {}
): LangChainAgent {
  return {
    async stream() {
      if (opts.throwOnStream) throw new Error("stream failed");
      return asyncFrom(tuples);
    },
  };
}

describe("LangChainAdapter", () => {
  describe("name", () => {
    test("uses explicit options.name", () => {
      const adapter = new LangChainAdapter(fakeAgent([]), {
        name: "Weather Bot",
      });
      expect(adapter.name).toBe("Weather Bot");
    });

    test("defaults to 'LangChain Agent'", () => {
      expect(new LangChainAdapter(fakeAgent([])).name).toBe("LangChain Agent");
    });
  });

  describe("stream", () => {
    test("calls onChunk for each streamed text block", async () => {
      const agent = fakeAgent([
        ["messages", [aiMessage([{ type: "text", text: "Hello" }]), {}]],
        ["messages", [aiMessage([{ type: "text", text: " world" }]), {}]],
      ]);
      const adapter = new LangChainAdapter(agent);
      const hooks = createHooks();

      await adapter.stream("hi", hooks, defaultOptions);

      expect(hooks.chunks).toEqual(["Hello", " world"]);
      expect(hooks.finishCount).toBe(1);
    });

    test("ignores non-assistant messages (tool results) in messages mode", async () => {
      const toolMessage = { _getType: () => "tool", contentBlocks: [{ type: "text", text: "42" }] };
      const agent = fakeAgent([
        ["messages", [toolMessage, { langgraph_node: "tools" }]],
        ["messages", [aiMessage([{ type: "text", text: "answer" }]), {}]],
      ]);
      const adapter = new LangChainAdapter(agent);
      const hooks = createHooks();

      await adapter.stream("hi", hooks, defaultOptions);

      expect(hooks.chunks).toEqual(["answer"]);
    });

    test("maps reasoning to THINKING then GENERATING on first text", async () => {
      const agent = fakeAgent([
        ["messages", [aiMessage([{ type: "reasoning", text: "thinking..." }]), {}]],
        ["messages", [aiMessage([{ type: "text", text: "answer" }]), {}]],
      ]);
      const adapter = new LangChainAdapter(agent);
      const hooks = createHooks();

      await adapter.stream("think", hooks, defaultOptions);

      expect(hooks.statuses).toEqual([
        { status: "THINKING" },
        { status: "GENERATING" },
      ]);
      expect(hooks.chunks).toEqual(["answer"]);
    });

    test("emits THINKING once then GENERATING once across consecutive reasoning blocks", async () => {
      const agent = fakeAgent([
        ["messages", [aiMessage([{ type: "reasoning", text: "a" }]), {}]],
        ["messages", [aiMessage([{ type: "reasoning", text: "b" }]), {}]],
        ["messages", [aiMessage([{ type: "text", text: "done" }]), {}]],
      ]);
      const adapter = new LangChainAdapter(agent);
      const hooks = createHooks();

      await adapter.stream("think", hooks, defaultOptions);

      // THINKING fires once for the run of reasoning blocks, then GENERATING
      // fires once when the first text block arrives.
      expect(hooks.statuses).toEqual([
        { status: "THINKING" },
        { status: "GENERATING" },
      ]);
      expect(hooks.chunks).toEqual(["done"]);
    });

    test("maps tool calls to PROCESSING with the tool name", async () => {
      const agent = fakeAgent([
        ["updates", { model: { messages: [{ tool_calls: [{ name: "weather" }] }] } }],
      ]);
      const adapter = new LangChainAdapter(agent);
      const hooks = createHooks();

      await adapter.stream("weather?", hooks, defaultOptions);

      const processing = hooks.statuses.find((s) => s.status === "PROCESSING");
      expect(processing?.customMessage).toBe("Running weather");
    });

    test("maps tool results to ANALYZING with the tool name", async () => {
      const agent = fakeAgent([
        ["updates", { tools: { messages: [{ name: "weather" }] } }],
      ]);
      const adapter = new LangChainAdapter(agent);
      const hooks = createHooks();

      await adapter.stream("weather?", hooks, defaultOptions);

      const analyzing = hooks.statuses.find((s) => s.status === "ANALYZING");
      expect(analyzing?.customMessage).toBe("Finished weather");
    });

    test("handles the 'agent' node name (createReactAgent) for tool calls", async () => {
      const agent = fakeAgent([
        ["updates", { agent: { messages: [{ tool_calls: [{ name: "search" }] }] } }],
      ]);
      const adapter = new LangChainAdapter(agent);
      const hooks = createHooks();

      await adapter.stream("q", hooks, defaultOptions);

      expect(hooks.statuses.find((s) => s.status === "PROCESSING")?.customMessage).toBe(
        "Running search"
      );
    });

    test("calls onError when the stream throws", async () => {
      const adapter = new LangChainAdapter(fakeAgent([], { throwOnStream: true }));
      const hooks = createHooks();

      await adapter.stream("hi", hooks, defaultOptions);

      expect(hooks.errors).toHaveLength(1);
      expect(hooks.errors[0].message).toBe("stream failed");
      expect(hooks.finishCount).toBe(0);
    });

    test("supports string content as a fallback for chunk text", async () => {
      const agent = fakeAgent([
        ["messages", [{ _getType: () => "ai", content: "plain text" }, {}]],
      ]);
      const adapter = new LangChainAdapter(agent);
      const hooks = createHooks();

      await adapter.stream("hi", hooks, defaultOptions);

      expect(hooks.chunks).toEqual(["plain text"]);
    });

    test("supports array content as a fallback (Anthropic-style blocks and raw strings)", async () => {
      const agent = fakeAgent([
        [
          "messages",
          [
            {
              _getType: () => "ai",
              content: [{ type: "text", text: "block" }, " and raw"],
            },
            {},
          ],
        ],
      ]);
      const adapter = new LangChainAdapter(agent);
      const hooks = createHooks();

      await adapter.stream("hi", hooks, defaultOptions);

      expect(hooks.chunks).toEqual(["block", " and raw"]);
    });

    test("recognizes assistant messages via getType/type/role fallbacks", async () => {
      const agent = fakeAgent([
        ["messages", [{ getType: () => "ai", contentBlocks: [{ type: "text", text: "a" }] }, {}]],
        ["messages", [{ type: "ai", contentBlocks: [{ type: "text", text: "b" }] }, {}]],
        ["messages", [{ role: "ai", contentBlocks: [{ type: "text", text: "c" }] }, {}]],
      ]);
      const adapter = new LangChainAdapter(agent);
      const hooks = createHooks();

      await adapter.stream("hi", hooks, defaultOptions);

      expect(hooks.chunks).toEqual(["a", "b", "c"]);
    });

    test("falls back to 'tool' when tool calls and results have no name", async () => {
      const agent = fakeAgent([
        ["updates", { model: { messages: [{ tool_calls: [{}] }] } }],
        ["updates", { tools: { messages: [{}] } }],
      ]);
      const adapter = new LangChainAdapter(agent);
      const hooks = createHooks();

      await adapter.stream("q", hooks, defaultOptions);

      expect(hooks.statuses.find((s) => s.status === "PROCESSING")?.customMessage).toBe(
        "Running tool"
      );
      expect(hooks.statuses.find((s) => s.status === "ANALYZING")?.customMessage).toBe(
        "Finished tool"
      );
    });

    test("passes streamMode and the conversation thread id to the agent", async () => {
      let captured: {
        input?: unknown;
        options?: Record<string, unknown>;
      } = {};
      const agent: LangChainAgent = {
        async stream(input, options) {
          captured = { input, options };
          return asyncFrom([]);
        },
      };
      const adapter = new LangChainAdapter(agent);

      await adapter.stream("hi", createHooks(), {
        conversationId: "conv-42",
        userId: "user-1",
      });

      expect(captured.input).toEqual({
        messages: [{ role: "user", content: "hi" }],
      });
      expect(captured.options?.streamMode).toEqual(["messages", "updates"]);
      expect(captured.options?.configurable).toEqual({ thread_id: "conv-42" });
    });
  });

  describe("getConfig", () => {
    test("returns the instructions option as systemPrompt", () => {
      const adapter = new LangChainAdapter(fakeAgent([]), {
        instructions: "You are a helpful assistant.",
      });
      expect(adapter.getConfig().systemPrompt).toBe("You are a helpful assistant.");
    });

    test("returns empty systemPrompt and tools by default", () => {
      const config = new LangChainAdapter(fakeAgent([])).getConfig();
      expect(config.systemPrompt).toBe("");
      expect(config.tools).toEqual([]);
    });

    test("maps tools to tool configs with name fallback for title", () => {
      const adapter = new LangChainAdapter(fakeAgent([]), {
        tools: [
          { name: "weather", description: "Get current weather" },
          { name: "calc" },
        ],
      });
      const config = adapter.getConfig();

      expect(config.tools).toHaveLength(2);
      const weather = config.tools.find((t) => t.name === "weather")!;
      expect(weather.title).toBe("weather");
      expect(weather.description).toBe("Get current weather");
      expect(weather.type).toBe("other");

      const calc = config.tools.find((t) => t.name === "calc")!;
      expect(calc.description).toBe("");
    });

    test("falls back to 'tool' for name and title when a tool has no name", () => {
      const adapter = new LangChainAdapter(fakeAgent([]), {
        tools: [{ description: "Unnamed tool" }],
      });
      const config = adapter.getConfig();

      expect(config.tools).toHaveLength(1);
      expect(config.tools[0].name).toBe("tool");
      expect(config.tools[0].title).toBe("tool");
      expect(config.tools[0].description).toBe("Unnamed tool");
    });
  });
});
