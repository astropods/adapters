import { describe, test, expect, mock } from "bun:test";
import type { Agent, TextStreamPart, ToolSet } from "ai";
import type { StatusUpdate } from "@astropods/messaging";
import type { StreamOptions } from "@astropods/adapter-core";

mock.module("@astropods/adapter-core", () => ({
  logger: {
    info: () => {},
    debug: () => {},
    error: () => {},
    warn: () => {},
  },
}));

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
    stream: async () => ({ fullStream: asyncFrom(parts) } as any),
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
