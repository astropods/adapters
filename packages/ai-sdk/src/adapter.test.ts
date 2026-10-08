import { describe, test, expect } from "bun:test";
import type { Agent, TextStreamPart, ToolSet } from "ai";
import type { StatusUpdate } from "@astropods/messaging";
import type { StreamOptions } from "@astropods/adapter-core";

import { AISDKAdapter } from "./adapter";

function createHooks() {
  const result = {
    chunks: [] as string[],
    statuses: [] as StatusUpdate[],
    errors: [] as Error[],
    finishCount: 0,
    onChunk(text: string) { result.chunks.push(text); },
    onStatusUpdate(status: StatusUpdate) { result.statuses.push(status); },
    onError(error: Error) { result.errors.push(error); },
    onFinish() { result.finishCount++; },
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

function fakeAgent(
  parts: TextStreamPart<any>[],
  overrides: Partial<Agent<never, ToolSet, any>> = {}
): Agent<never, ToolSet, any> {
  return {
    version: "agent-v1",
    id: undefined,
    tools: {},
    generate: async () => ({} as any),
    stream: async () => ({ fullStream: asyncFrom(parts), response: Promise.resolve({ messages: [] }) } as any),
    ...overrides,
  } as Agent<never, ToolSet, any>;
}

describe("AISDKAdapter", () => {
  describe("name", () => {
    test("uses explicit options.name", () => {
      const adapter = new AISDKAdapter(fakeAgent([]), { name: "Weather Bot" });
      expect(adapter.name).toBe("Weather Bot");
    });

    test("falls back to agent.id when name is not provided", () => {
      const agent = fakeAgent([], { id: "weather-agent" });
      const adapter = new AISDKAdapter(agent);
      expect(adapter.name).toBe("weather-agent");
    });

    test("defaults to 'AI SDK Agent' when neither is provided", () => {
      const adapter = new AISDKAdapter(fakeAgent([]));
      expect(adapter.name).toBe("AI SDK Agent");
    });
  });

  describe("stream", () => {
    test("calls onChunk for each text-delta", async () => {
      const agent = fakeAgent([
        { type: "text-start", id: "t-0" },
        { type: "text-delta", id: "t-0", text: "Hello" },
        { type: "text-delta", id: "t-0", text: " world" },
        { type: "text-end", id: "t-0" },
        { type: "finish", finishReason: "stop", rawFinishReason: undefined, totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as any },
      ]);
      const adapter = new AISDKAdapter(agent);
      const hooks = createHooks();

      await adapter.stream("hi", hooks, defaultOptions);

      expect(hooks.chunks).toEqual(["Hello", " world"]);
    });

    test("calls onFinish on the finish event", async () => {
      const agent = fakeAgent([
        { type: "finish", finishReason: "stop", rawFinishReason: undefined, totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as any },
      ]);
      const adapter = new AISDKAdapter(agent);
      const hooks = createHooks();

      await adapter.stream("hi", hooks, defaultOptions);

      expect(hooks.finishCount).toBe(1);
    });

    test("maps reasoning-start/end to THINKING and GENERATING", async () => {
      const agent = fakeAgent([
        { type: "reasoning-start", id: "r-0" },
        { type: "reasoning-delta", id: "r-0", text: "thinking..." },
        { type: "reasoning-end", id: "r-0" },
        { type: "text-delta", id: "t-0", text: "answer" },
        { type: "finish", finishReason: "stop", rawFinishReason: undefined, totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as any },
      ]);
      const adapter = new AISDKAdapter(agent);
      const hooks = createHooks();

      await adapter.stream("think hard", hooks, defaultOptions);

      expect(hooks.statuses).toContainEqual({ status: "THINKING" });
      expect(hooks.statuses).toContainEqual({ status: "GENERATING" });
      expect(hooks.chunks).toContain("answer");
    });

    test("maps tool-input-start/end to PROCESSING and ANALYZING with the tool name", async () => {
      const agent = fakeAgent([
        { type: "tool-input-start", id: "tc-1", toolName: "weather" },
        { type: "tool-input-delta", id: "tc-1", delta: '{"city":"NYC"}' },
        { type: "tool-input-end", id: "tc-1" },
        { type: "text-delta", id: "t-0", text: "It's 72F" },
        { type: "finish", finishReason: "stop", rawFinishReason: undefined, totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as any },
      ]);
      const adapter = new AISDKAdapter(agent);
      const hooks = createHooks();

      await adapter.stream("weather?", hooks, defaultOptions);

      const processing = hooks.statuses.find((s) => s.status === "PROCESSING");
      const analyzing = hooks.statuses.find((s) => s.status === "ANALYZING");
      expect(processing?.customMessage).toContain("weather");
      expect(analyzing?.customMessage).toContain("weather");
    });

    test("falls back to 'tool' label when tool-input-end arrives without a prior start", async () => {
      const agent = fakeAgent([
        { type: "tool-input-end", id: "tc-orphan" },
        { type: "finish", finishReason: "stop", rawFinishReason: undefined, totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as any },
      ]);
      const adapter = new AISDKAdapter(agent);
      const hooks = createHooks();

      await adapter.stream("hi", hooks, defaultOptions);

      const analyzing = hooks.statuses.find((s) => s.status === "ANALYZING");
      expect(analyzing?.customMessage).toContain("tool");
    });

    test("calls onError for tool-error events", async () => {
      const err = new Error("tool blew up");
      const agent = fakeAgent([
        { type: "tool-error", toolCallId: "tc-1", toolName: "weather", input: {}, error: err, dynamic: false } as any,
        { type: "finish", finishReason: "error", rawFinishReason: undefined, totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as any },
      ]);
      const adapter = new AISDKAdapter(agent);
      const hooks = createHooks();

      await adapter.stream("hi", hooks, defaultOptions);

      expect(hooks.errors).toHaveLength(1);
      expect(hooks.errors[0].message).toBe("tool blew up");
    });

    test("calls onError for stream error events and wraps non-Error values", async () => {
      const agent = fakeAgent([
        { type: "error", error: "stringly error" },
      ]);
      const adapter = new AISDKAdapter(agent);
      const hooks = createHooks();

      await adapter.stream("hi", hooks, defaultOptions);

      expect(hooks.errors).toHaveLength(1);
      expect(hooks.errors[0].message).toBe("stringly error");
    });

    test("ignores lifecycle events that don't map to a hook (start, start-step, finish-step, text-start, text-end, tool-input-delta)", async () => {
      const agent = fakeAgent([
        { type: "start" },
        { type: "start-step", request: {} as any, warnings: [] },
        { type: "text-start", id: "t-0" },
        { type: "text-delta", id: "t-0", text: "hi" },
        { type: "text-end", id: "t-0" },
        { type: "tool-input-delta", id: "tc-1", delta: "{}" },
        { type: "finish-step", response: {} as any, usage: {} as any, finishReason: "stop", rawFinishReason: undefined, providerMetadata: undefined },
        { type: "finish", finishReason: "stop", rawFinishReason: undefined, totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as any },
      ]);
      const adapter = new AISDKAdapter(agent);
      const hooks = createHooks();

      await adapter.stream("hi", hooks, defaultOptions);

      expect(hooks.chunks).toEqual(["hi"]);
      expect(hooks.statuses).toEqual([]);
      expect(hooks.errors).toEqual([]);
      expect(hooks.finishCount).toBe(1);
    });
  });

  describe("getConfig", () => {
    test("returns the instructions option as systemPrompt", () => {
      const adapter = new AISDKAdapter(fakeAgent([]), {
        instructions: "You are a helpful assistant.",
      });
      expect(adapter.getConfig().systemPrompt).toBe("You are a helpful assistant.");
    });

    test("returns empty systemPrompt when instructions are not provided", () => {
      const adapter = new AISDKAdapter(fakeAgent([]));
      expect(adapter.getConfig().systemPrompt).toBe("");
    });

    test("returns empty tools when the agent has none", () => {
      const adapter = new AISDKAdapter(fakeAgent([]));
      expect(adapter.getConfig().tools).toEqual([]);
    });

    test("returns empty tools when agent.tools is undefined", () => {
      // A real Agent created without a `tools` option has `tools === undefined`,
      // not `{}` — getConfig() must not throw on Object.entries(undefined).
      const agent = fakeAgent([], { tools: undefined as any });
      const adapter = new AISDKAdapter(agent);
      expect(() => adapter.getConfig()).not.toThrow();
      expect(adapter.getConfig().tools).toEqual([]);
    });

    test("maps agent.tools to tool configs with description and title fallback", () => {
      const agent = fakeAgent([], {
        tools: {
          weather: { description: "Get current weather", title: "Weather" },
          search: { description: "Search the web" },
          calc: {},
        } as any,
      });
      const adapter = new AISDKAdapter(agent);
      const config = adapter.getConfig();

      expect(config.tools).toHaveLength(3);
      const weather = config.tools.find((t) => t.name === "weather")!;
      expect(weather.title).toBe("Weather");
      expect(weather.description).toBe("Get current weather");
      expect(weather.type).toBe("other");

      const search = config.tools.find((t) => t.name === "search")!;
      expect(search.title).toBe("search");
      expect(search.description).toBe("Search the web");

      const calc = config.tools.find((t) => t.name === "calc")!;
      expect(calc.title).toBe("calc");
      expect(calc.description).toBe("");
    });
  });
});

describe("AISDKAdapter conversation history", () => {
  function recordingAgent() {
    const calls: any[] = [];
    const agent = fakeAgent([], {
      stream: async (params: any) => {
        calls.push(params);
        const reply = `reply ${calls.length}`;
        return {
          fullStream: asyncFrom([{ type: "text-delta", id: "t-0", text: reply }]),
          responseMessages: Promise.resolve([{ role: "assistant", content: reply }]),
        } as any;
      },
    });
    return { agent, calls };
  }

  test("sends a conversation's earlier turns with its follow-up", async () => {
    const { agent, calls } = recordingAgent();
    const adapter = new AISDKAdapter(agent);

    await adapter.stream("first", createHooks(), defaultOptions);
    await adapter.stream("second", createHooks(), defaultOptions);

    expect(calls[1].messages).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "reply 1" },
      { role: "user", content: "second" },
    ]);
  });

  test("keeps each conversation's history to itself", async () => {
    const { agent, calls } = recordingAgent();
    const adapter = new AISDKAdapter(agent);

    await adapter.stream("first", createHooks(), defaultOptions);
    await adapter.stream("other", createHooks(), { ...defaultOptions, conversationId: "conv-2" });

    expect(calls[1].messages).toEqual([{ role: "user", content: "other" }]);
  });

  test("drops the oldest whole turns past maxTurns", async () => {
    const { agent, calls } = recordingAgent();
    const adapter = new AISDKAdapter(agent, { maxTurns: 1 });

    await adapter.stream("first", createHooks(), defaultOptions);
    await adapter.stream("second", createHooks(), defaultOptions);
    await adapter.stream("third", createHooks(), defaultOptions);

    expect(calls[2].messages).toEqual([
      { role: "user", content: "second" },
      { role: "assistant", content: "reply 2" },
      { role: "user", content: "third" },
    ]);
  });

  test("drops the oldest whole turns once the history passes maxHistoryBytes", async () => {
    const { agent, calls } = recordingAgent();
    const adapter = new AISDKAdapter(agent, { maxHistoryBytes: 200 });
    const [first, second, third] = ["a", "b", "c"].map((c) => c.repeat(100));

    await adapter.stream(first, createHooks(), defaultOptions);
    await adapter.stream(second, createHooks(), defaultOptions);
    await adapter.stream(third, createHooks(), defaultOptions);

    expect(calls[2].messages).toEqual([
      { role: "user", content: second },
      { role: "assistant", content: "reply 2" },
      { role: "user", content: third },
    ]);
  });

  test("forgets the least recently used conversation past maxConversations", async () => {
    const { agent, calls } = recordingAgent();
    const adapter = new AISDKAdapter(agent, { maxConversations: 2 });
    const turn = (conversationId: string, prompt: string) =>
      adapter.stream(prompt, createHooks(), { ...defaultOptions, conversationId });

    await turn("a", "a1");
    await turn("b", "b1");
    await turn("a", "a2");
    await turn("c", "c1");
    await turn("a", "a3");
    await turn("b", "b2");

    expect(calls[4].messages.map((m: any) => m.content)).toEqual(["a1", "reply 1", "a2", "reply 3", "a3"]);
    expect(calls[5].messages).toEqual([{ role: "user", content: "b2" }]);
  });

  test("forwards the stop signal to the model call", async () => {
    const { agent, calls } = recordingAgent();
    const adapter = new AISDKAdapter(agent);
    const controller = new AbortController();

    await adapter.stream("first", createHooks(), { ...defaultOptions, signal: controller.signal });

    expect(calls[0].abortSignal).toBe(controller.signal);
  });
});

describe("AISDKAdapter with a real ToolLoopAgent", () => {
  test("the model sees the earlier turn on a follow-up", async () => {
    const { ToolLoopAgent, simulateReadableStream } = await import("ai");
    const { MockLanguageModelV4 } = await import("ai/test");
    const prompts: unknown[] = [];
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }: any) => {
        prompts.push(prompt);
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "t-0" },
              { type: "text-delta", id: "t-0", delta: `reply ${prompts.length}` },
              { type: "text-end", id: "t-0" },
              { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } },
            ] as any,
          }),
        };
      },
    });
    const adapter = new AISDKAdapter(new ToolLoopAgent({ model }) as any);

    await adapter.stream("first", createHooks(), defaultOptions);
    const hooks = createHooks();
    await adapter.stream("second", hooks, defaultOptions);

    expect(hooks.errors).toEqual([]);
    expect(JSON.stringify(prompts[1])).toContain("reply 1");
    expect(JSON.stringify(prompts[1])).toContain("first");
  });
});

describe("AISDKAdapter failed turns", () => {
  test("does not record a turn that ended in an error", async () => {
    const calls: any[] = [];
    const agent = fakeAgent([], {
      stream: async (params: any) => {
        calls.push(params);
        const parts = calls.length === 1 ? [{ type: "error", error: new Error("boom") }] : [];
        return { fullStream: asyncFrom(parts), response: Promise.resolve({ messages: [] }) } as any;
      },
    });
    const adapter = new AISDKAdapter(agent);

    await adapter.stream("first", createHooks(), defaultOptions);
    await adapter.stream("second", createHooks(), defaultOptions);

    expect(calls[1].messages).toEqual([{ role: "user", content: "second" }]);
  });
});

describe("AISDKAdapter history with tools on a real ToolLoopAgent", () => {
  const finish = (unified: string) => ({
    type: "finish",
    finishReason: { unified, raw: undefined },
    usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
  });

  async function toolAgent(withExecute: boolean) {
    const { ToolLoopAgent, jsonSchema, simulateReadableStream, stepCountIs, tool } = await import("ai");
    const { MockLanguageModelV4 } = await import("ai/test");
    const prompts: any[] = [];
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }: any) => {
        prompts.push(prompt);
        const last = prompt.at(-1);
        const text = JSON.stringify(last.content);
        const chunks =
          last.role === "user" && text.includes("look it up")
            ? [{ type: "tool-call", toolCallId: "c1", toolName: "lookup", input: "{}" }, finish("tool-calls")]
            : [
                { type: "text-start", id: "t-0" },
                { type: "text-delta", id: "t-0", delta: "answer" },
                { type: "text-end", id: "t-0" },
                finish("stop"),
              ];
        return { stream: simulateReadableStream({ chunks: chunks as any }) };
      },
    });
    const lookup = withExecute
      ? tool({ description: "Look up", inputSchema: jsonSchema({ type: "object", properties: {} }), execute: async () => "TOOLRESULT42" })
      : tool({ description: "Look up", inputSchema: jsonSchema({ type: "object", properties: {} }) });
    const agent = new ToolLoopAgent({ model, tools: { lookup }, stopWhen: stepCountIs(5) });
    return { adapter: new AISDKAdapter(agent as any), prompts };
  }

  test("a follow-up carries the earlier turn's tool call and result", async () => {
    const { adapter, prompts } = await toolAgent(true);

    await adapter.stream("look it up", createHooks(), defaultOptions);
    await adapter.stream("and then?", createHooks(), defaultOptions);

    const followUp = JSON.stringify(prompts.at(-1));
    expect(followUp).toContain('"tool-call"');
    expect(followUp).toContain("TOOLRESULT42");
  });

  test("a turn that ends on an unanswered tool call does not break the follow-up", async () => {
    const { adapter, prompts } = await toolAgent(false);

    await adapter.stream("look it up", createHooks(), defaultOptions);
    const hooks = createHooks();
    await adapter.stream("and then?", hooks, defaultOptions);

    expect(hooks.errors).toEqual([]);
    expect(prompts).toHaveLength(2);
    expect(JSON.stringify(prompts[1])).not.toContain('"tool-call"');
  });
});

describe("AISDKAdapter history rules", () => {
  function scriptedAgent(script: (call: number) => { parts?: any[]; messages?: any[]; gate?: Promise<void> }) {
    const calls: any[] = [];
    const agent = fakeAgent([], {
      stream: async (params: any) => {
        calls.push(params);
        const n = calls.length;
        const { parts = [], messages = [{ role: "assistant", content: `reply ${n}` }], gate } = script(n);
        async function* gated() {
          if (gate) await gate;
          yield* parts;
        }
        return { fullStream: gated(), responseMessages: Promise.resolve(messages) } as any;
      },
    });
    return { agent, calls };
  }
  const contents = (call: any) => call.messages.map((m: any) => (typeof m.content === "string" ? m.content : m.content[0]?.type));

  test("a failed turn drops the older half of the history", async () => {
    const { agent, calls } = scriptedAgent((n) => (n === 3 ? { parts: [{ type: "error", error: new Error("context too long") }] } : {}));
    const adapter = new AISDKAdapter(agent);

    await adapter.stream("first", createHooks(), defaultOptions);
    await adapter.stream("second", createHooks(), defaultOptions);
    await adapter.stream("third fails", createHooks(), defaultOptions);
    await adapter.stream("fourth", createHooks(), defaultOptions);

    expect(contents(calls[3])).toEqual(["second", "reply 2", "fourth"]);
  });

  test("repeated failures clear the history, so the conversation recovers", async () => {
    const { agent, calls } = scriptedAgent((n) => (n === 2 || n === 3 ? { parts: [{ type: "error", error: new Error("boom") }] } : {}));
    const adapter = new AISDKAdapter(agent);

    await adapter.stream("first", createHooks(), defaultOptions);
    await adapter.stream("fails", createHooks(), defaultOptions);
    await adapter.stream("fails again", createHooks(), defaultOptions);
    await adapter.stream("recovered", createHooks(), defaultOptions);

    expect(contents(calls[3])).toEqual(["recovered"]);
  });

  test("a stopped turn is not kept and does not shrink the history", async () => {
    const { agent, calls } = scriptedAgent((n) => (n === 2 ? { parts: [{ type: "abort" }] } : {}));
    const adapter = new AISDKAdapter(agent);

    await adapter.stream("first", createHooks(), defaultOptions);
    await adapter.stream("stopped", createHooks(), defaultOptions);
    await adapter.stream("third", createHooks(), defaultOptions);

    expect(contents(calls[2])).toEqual(["first", "reply 1", "third"]);
  });

  test("overlapping turns in one conversation are both kept", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { agent, calls } = scriptedAgent((n) => (n === 1 ? { gate } : {}));
    const adapter = new AISDKAdapter(agent);

    const slow = adapter.stream("slow", createHooks(), defaultOptions);
    await adapter.stream("fast", createHooks(), defaultOptions);
    release();
    await slow;
    await adapter.stream("next", createHooks(), defaultOptions);

    expect(contents(calls[2])).toEqual(["fast", "reply 2", "slow", "reply 1", "next"]);
  });

  test("an oversized tool output is compacted, keeping earlier turns", async () => {
    const page = "x".repeat(5000);
    const { agent, calls } = scriptedAgent((n) =>
      n === 2
        ? {
            messages: [
              { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "fetch", input: {} }] },
              { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "fetch", output: { type: "text", value: page } }] },
              { role: "assistant", content: "summary" },
            ],
          }
        : {}
    );
    const adapter = new AISDKAdapter(agent, { maxHistoryBytes: 2000 });

    await adapter.stream("first", createHooks(), defaultOptions);
    await adapter.stream("fetch the page", createHooks(), defaultOptions);
    await adapter.stream("and?", createHooks(), defaultOptions);

    const sent = JSON.stringify(calls[2].messages);
    expect(sent).toContain('"first"');
    expect(sent).toContain('"tool-call"');
    expect(sent).toContain("bytes of tool output dropped from history");
    expect(sent).not.toContain(page);
  });

  test("memory: false sends only the prompt", async () => {
    const { agent, calls } = scriptedAgent(() => ({}));
    const adapter = new AISDKAdapter(agent, { memory: false });

    await adapter.stream("first", createHooks(), defaultOptions);
    await adapter.stream("second", createHooks(), defaultOptions);

    expect(calls[1]).toEqual({ prompt: "second", abortSignal: undefined });
  });

  test("maxTurns: 0 turns history off", async () => {
    const { agent, calls } = scriptedAgent(() => ({}));
    const adapter = new AISDKAdapter(agent, { maxTurns: 0 });

    await adapter.stream("first", createHooks(), defaultOptions);
    await adapter.stream("second", createHooks(), defaultOptions);

    expect(calls[1].prompt).toBe("second");
    expect(calls[1].messages).toBeUndefined();
  });

  test("an empty conversation ID gets no shared history", async () => {
    const { agent, calls } = scriptedAgent(() => ({}));
    const adapter = new AISDKAdapter(agent);

    await adapter.stream("first", createHooks(), { ...defaultOptions, conversationId: "" });
    await adapter.stream("second", createHooks(), { ...defaultOptions, conversationId: "" });

    expect(calls[1].prompt).toBe("second");
  });

  test("rejects a limit that is not a non-negative integer", () => {
    const agent = fakeAgent([]);
    for (const bad of [{ maxTurns: -1 }, { maxHistoryBytes: Number.NaN }, { maxConversations: 1.5 }]) {
      expect(() => new AISDKAdapter(agent, bad)).toThrow(RangeError);
    }
  });

  test("reads response.messages on ai 6, which has no responseMessages", async () => {
    const calls: any[] = [];
    const agent = fakeAgent([], {
      stream: async (params: any) => {
        calls.push(params);
        return { fullStream: asyncFrom([]), response: Promise.resolve({ messages: [{ role: "assistant", content: "v6 reply" }] }) } as any;
      },
    });
    const adapter = new AISDKAdapter(agent);

    await adapter.stream("first", createHooks(), defaultOptions);
    await adapter.stream("second", createHooks(), defaultOptions);

    expect(contents(calls[1])).toEqual(["first", "v6 reply", "second"]);
  });
});

describe("AISDKAdapter edited conversations", () => {
  function recordingAgent() {
    const calls: any[] = [];
    const agent = fakeAgent([], {
      stream: async (params: any) => {
        calls.push(params);
        const reply = `reply ${calls.length}`;
        return {
          fullStream: asyncFrom([{ type: "text-delta", id: "t-0", text: reply }]),
          responseMessages: Promise.resolve([{ role: "assistant", content: reply }]),
        } as any;
      },
    });
    return { agent, calls };
  }

  const edit: NonNullable<StreamOptions["history"]> = {
    messages: [
      { id: "h1", role: "user", content: "first" },
      { id: "h2", role: "assistant", content: "reply 1" },
    ],
    isComplete: true,
  };

  async function seed(adapter: AISDKAdapter) {
    await adapter.stream("first", createHooks(), defaultOptions);
    await adapter.stream("second", createHooks(), defaultOptions);
  }

  test("an edit replaces the conversation's history with the given turns", async () => {
    const { agent, calls } = recordingAgent();
    const adapter = new AISDKAdapter(agent);
    await seed(adapter);

    await adapter.stream("second edited", createHooks(), { ...defaultOptions, history: edit });

    expect(calls[2].messages).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "reply 1" },
      { role: "user", content: "second edited" },
    ]);
  });

  test("an empty history clears the conversation", async () => {
    const { agent, calls } = recordingAgent();
    const adapter = new AISDKAdapter(agent);
    await seed(adapter);

    await adapter.stream("first edited", createHooks(), {
      ...defaultOptions,
      history: { messages: [], isComplete: true },
    });

    expect(calls[2].messages).toEqual([{ role: "user", content: "first edited" }]);
  });

  test("a send without history keeps the edited branch", async () => {
    const { agent, calls } = recordingAgent();
    const adapter = new AISDKAdapter(agent);
    await seed(adapter);
    await adapter.stream("second edited", createHooks(), { ...defaultOptions, history: edit });

    await adapter.stream("third", createHooks(), defaultOptions);

    expect(calls[3].messages).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "reply 1" },
      { role: "user", content: "second edited" },
      { role: "assistant", content: "reply 3" },
      { role: "user", content: "third" },
    ]);
  });

  test("declares history support only when the adapter keeps the history", () => {
    const { agent } = recordingAgent();
    expect(new AISDKAdapter(agent).getConfig().supportsHistory).toBe(true);
    expect(new AISDKAdapter(agent, { memory: false }).getConfig().supportsHistory).toBe(false);
    expect(new AISDKAdapter(agent, { maxTurns: 0 }).getConfig().supportsHistory).toBe(false);
  });
});
