import { describe, test, expect, mock } from "bun:test";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  MastraLanguageModelV2Mock,
  simulateReadableStream,
} from "@mastra/core/test-utils/llm-mock";
import type { LanguageModelV2StreamPart } from "@ai-sdk/provider-v5";
import type { StatusUpdate } from "@astropods/messaging";
import type { StreamOptions } from "@astropods/adapter-core";
import { MastraAdapter } from "./adapter";

// --- Helpers ---

function createHooks() {
  const result = {
    chunks: [] as string[],
    statuses: [] as StatusUpdate[],
    errors: [] as Error[],
    finishCount: 0,
    transcripts: [] as string[],
    audioChunks: [] as Uint8Array[],
    audioEndCount: 0,
    onChunk(text: string) { result.chunks.push(text); },
    onStatusUpdate(status: StatusUpdate) { result.statuses.push(status); },
    onError(error: Error) { result.errors.push(error); },
    onFinish() { result.finishCount++; },
    onTranscript(text: string) { result.transcripts.push(text); },
    onAudioChunk(data: Uint8Array) { result.audioChunks.push(data); },
    onAudioEnd() { result.audioEndCount++; },
  };
  return result;
}

const defaultOptions: StreamOptions = {
  conversationId: "conv-1",
  userId: "user-1",
};

function streamFromParts(parts: LanguageModelV2StreamPart[]) {
  return simulateReadableStream({ chunks: parts, chunkDelayInMs: 0 });
}

function textParts(tokens: string[]): LanguageModelV2StreamPart[] {
  const id = "text-0";
  return [
    { type: "text-start" as const, id },
    ...tokens.map((t) => ({ type: "text-delta" as const, id, delta: t })),
    { type: "text-end" as const, id },
    {
      type: "finish" as const,
      finishReason: "stop" as const,
      usage: { inputTokens: 10, outputTokens: tokens.length, totalTokens: 10 + tokens.length },
    },
  ];
}

function modelFromParts(parts: LanguageModelV2StreamPart[]) {
  return new MastraLanguageModelV2Mock({
    provider: "test",
    modelId: "test-model",
    doStream: async () => ({ stream: streamFromParts(parts) }),
  });
}

// --- Tests ---

describe("MastraAdapter", () => {
  describe("name", () => {
    test("is set from the Mastra agent name", () => {
      const agent = new Agent({
        id: "weather-bot",
        name: "Weather Bot",
        model: modelFromParts(textParts(["hi"])),
        instructions: "test",
      });
      const adapter = new MastraAdapter(agent);

      expect(adapter.name).toBe("Weather Bot");
    });
  });

  describe("stream", () => {
    test("calls onChunk for each text token", async () => {
      const agent = new Agent({
        id: "test",
        name: "Test",
        model: modelFromParts(textParts(["Hello", " world"])),
        instructions: "test",
      });
      const adapter = new MastraAdapter(agent);
      const hooks = createHooks();

      await adapter.stream("hi", hooks, defaultOptions);

      expect(hooks.chunks).toEqual(["Hello", " world"]);
    });

    test("calls onFinish when stream completes", async () => {
      const agent = new Agent({
        id: "test",
        name: "Test",
        model: modelFromParts(textParts(["done"])),
        instructions: "test",
      });
      const adapter = new MastraAdapter(agent);
      const hooks = createHooks();

      await adapter.stream("test", hooks, defaultOptions);

      expect(hooks.finishCount).toBe(1);
    });

    test("maps reasoning to THINKING and GENERATING statuses", async () => {
      const parts: LanguageModelV2StreamPart[] = [
        { type: "reasoning-start", id: "r-0" },
        { type: "reasoning-delta", id: "r-0", delta: "Let me think..." },
        { type: "reasoning-end", id: "r-0" },
        { type: "text-start", id: "t-0" },
        { type: "text-delta", id: "t-0", delta: "Answer" },
        { type: "text-end", id: "t-0" },
        { type: "finish", finishReason: "stop", usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 } },
      ];

      const agent = new Agent({
        id: "test",
        name: "Test",
        model: modelFromParts(parts),
        instructions: "test",
      });
      const adapter = new MastraAdapter(agent);
      const hooks = createHooks();

      await adapter.stream("think hard", hooks, defaultOptions);

      expect(hooks.statuses).toContainEqual({ status: "THINKING" });
      expect(hooks.statuses).toContainEqual({ status: "GENERATING" });
      expect(hooks.chunks).toContain("Answer");
    });

    test("maps tool execution to PROCESSING and ANALYZING statuses", async () => {
      const weatherTool = createTool({
        id: "weather",
        description: "Get weather",
        inputSchema: z.object({ location: z.string() }),
        outputSchema: z.object({ temp: z.string() }),
        execute: async () => ({ temp: "72F" }),
      });

      // Step 1: Model returns tool call
      const toolCallParts: LanguageModelV2StreamPart[] = [
        { type: "tool-input-start", id: "tc-1", toolName: "weather" },
        { type: "tool-input-delta", id: "tc-1", delta: '{"location":"NYC"}' },
        { type: "tool-input-end", id: "tc-1" },
        { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
      ];

      // Step 2: After tool execution, model returns text
      const textResponseParts: LanguageModelV2StreamPart[] = [
        { type: "text-start", id: "t-0" },
        { type: "text-delta", id: "t-0", delta: "It's 72F" },
        { type: "text-end", id: "t-0" },
        { type: "finish", finishReason: "stop", usage: { inputTokens: 15, outputTokens: 3, totalTokens: 18 } },
      ];

      let callCount = 0;
      const model = new MastraLanguageModelV2Mock({
        provider: "test",
        modelId: "test-model",
        doStream: async () => {
          callCount++;
          const parts = callCount === 1 ? toolCallParts : textResponseParts;
          return { stream: streamFromParts(parts) };
        },
      });

      const agent = new Agent({
        id: "test",
        name: "Test",
        model,
        instructions: "Use the weather tool.",
        tools: { weather: weatherTool },
        defaultOptions: { maxSteps: 5 },
      });
      const adapter = new MastraAdapter(agent);
      const hooks = createHooks();

      await adapter.stream("weather in NYC?", hooks, defaultOptions);

      const processingStatus = hooks.statuses.find((s: StatusUpdate) => s.status === "PROCESSING");
      const analyzingStatus = hooks.statuses.find((s: StatusUpdate) => s.status === "ANALYZING");

      expect(processingStatus).toBeDefined();
      expect(processingStatus!.customMessage).toContain("weather");
      expect(analyzingStatus).toBeDefined();
      expect(analyzingStatus!.customMessage).toContain("weather");
      expect(hooks.chunks).toContain("It's 72F");
      expect(hooks.finishCount).toBe(1);
    });

    test("handles multiple text chunks in sequence", async () => {
      const agent = new Agent({
        id: "test",
        name: "Test",
        model: modelFromParts(textParts(["A", "B", "C", "D", "E"])),
        instructions: "test",
      });
      const adapter = new MastraAdapter(agent);
      const hooks = createHooks();

      await adapter.stream("count", hooks, defaultOptions);

      expect(hooks.chunks).toEqual(["A", "B", "C", "D", "E"]);
      expect(hooks.finishCount).toBe(1);
    });
  });

  describe("streamAudio", () => {
    test("errors when agent has no voice provider", async () => {
      const agent = new Agent({
        id: "test",
        name: "Test",
        model: modelFromParts(textParts(["hi"])),
        instructions: "test",
      });
      // Remove the default voice stub
      Object.defineProperty(agent, "voice", { value: undefined, configurable: true });

      const adapter = new MastraAdapter(agent);
      const hooks = createHooks();

      const audioInput = {
        stream: new ReadableStream<Uint8Array>(),
        config: { encoding: "MULAW", sampleRate: 8000, channels: 1, conversationId: "c1" },
        filetype: "wav",
      };

      await adapter.streamAudio!(audioInput as any, hooks, defaultOptions);

      expect(hooks.errors).toHaveLength(1);
      expect(hooks.errors[0].message).toContain("no voice provider");
    });

    test("passes accumulated text to TTS instead of making a second LLM call", async () => {
      const parts = textParts(["Hello", " world"]);
      let speakInput: string | null = null;
      let streamCallCount = 0;

      const model = new MastraLanguageModelV2Mock({
        provider: "test",
        modelId: "test-model",
        doStream: async () => {
          streamCallCount++;
          return { stream: streamFromParts(parts) };
        },
      });

      const agent = new Agent({
        id: "test",
        name: "Test",
        model,
        instructions: "test",
      });

      const audioChunk = new Uint8Array([1, 2, 3]);
      Object.defineProperty(agent, "voice", {
        value: {
          listen: async () => "transcribed text",
          speak: async (text: string) => {
            speakInput = text;
            return new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(audioChunk);
                controller.close();
              },
            });
          },
        },
        configurable: true,
      });

      const adapter = new MastraAdapter(agent);
      const hooks = createHooks();

      const audioInput = {
        stream: new ReadableStream<Uint8Array>(),
        config: { encoding: "MULAW", sampleRate: 8000, channels: 1, conversationId: "c1" },
        filetype: "wav",
      };

      await adapter.streamAudio!(audioInput as any, hooks, defaultOptions);

      // Only one LLM call (stream), not two (stream + generate)
      expect(streamCallCount).toBe(1);
      // TTS received the accumulated streamed text
      expect(speakInput).toBe("Hello world");
      // Text was still streamed to the client
      expect(hooks.chunks).toEqual(["Hello", " world"]);
      // Audio chunks were forwarded
      expect(hooks.audioChunks).toHaveLength(1);
      expect(hooks.audioEndCount).toBe(1);
    });

    test("defers onFinish until after TTS completes", async () => {
      const parts = textParts(["Reply"]);
      const callOrder: string[] = [];

      const model = new MastraLanguageModelV2Mock({
        provider: "test",
        modelId: "test-model",
        doStream: async () => ({ stream: streamFromParts(parts) }),
      });

      const agent = new Agent({
        id: "test",
        name: "Test",
        model,
        instructions: "test",
      });

      Object.defineProperty(agent, "voice", {
        value: {
          listen: async () => "transcribed text",
          speak: async () => {
            callOrder.push("speak");
            return new ReadableStream<Uint8Array>({
              start(controller) { controller.close(); },
            });
          },
        },
        configurable: true,
      });

      const adapter = new MastraAdapter(agent);
      const hooks = createHooks();
      const origOnFinish = hooks.onFinish.bind(hooks);
      hooks.onFinish = () => {
        callOrder.push("onFinish");
        origOnFinish();
      };

      const audioInput = {
        stream: new ReadableStream<Uint8Array>(),
        config: { encoding: "MULAW", sampleRate: 8000, channels: 1, conversationId: "c1" },
        filetype: "wav",
      };

      await adapter.streamAudio!(audioInput as any, hooks, defaultOptions);

      // onFinish should come after speak
      expect(callOrder).toEqual(["speak", "onFinish"]);
      expect(hooks.finishCount).toBe(1);
    });

    test("calls onFinish immediately when TTS is not available", async () => {
      const parts = textParts(["Reply"]);

      const model = new MastraLanguageModelV2Mock({
        provider: "test",
        modelId: "test-model",
        doStream: async () => ({ stream: streamFromParts(parts) }),
      });

      const agent = new Agent({
        id: "test",
        name: "Test",
        model,
        instructions: "test",
      });

      // Voice with listen but no speak
      Object.defineProperty(agent, "voice", {
        value: {
          listen: async () => "transcribed text",
        },
        configurable: true,
      });

      const adapter = new MastraAdapter(agent);
      const hooks = createHooks();

      const audioInput = {
        stream: new ReadableStream<Uint8Array>(),
        config: { encoding: "MULAW", sampleRate: 8000, channels: 1, conversationId: "c1" },
        filetype: "wav",
      };

      await adapter.streamAudio!(audioInput as any, hooks, defaultOptions);

      // onFinish fires via stream() directly, no TTS
      expect(hooks.finishCount).toBe(1);
      expect(hooks.chunks).toEqual(["Reply"]);
      expect(hooks.audioChunks).toHaveLength(0);
    });

    test("logs TTS failure as warning instead of swallowing silently", async () => {
      const warnSpy = mock(() => {});
      const origWarn = console.warn;
      console.warn = warnSpy;

      try {
        const parts = textParts(["Response text"]);

        const model = new MastraLanguageModelV2Mock({
          provider: "test",
          modelId: "test-model",
          doStream: async () => ({ stream: streamFromParts(parts) }),
        });

        const agent = new Agent({
          id: "test",
          name: "Test",
          model,
          instructions: "test",
        });

        Object.defineProperty(agent, "voice", {
          value: {
            listen: async () => "transcribed text",
            speak: async () => { throw new Error("TTS service unavailable"); },
          },
          configurable: true,
        });

        const adapter = new MastraAdapter(agent);
        const hooks = createHooks();

        const audioInput = {
          stream: new ReadableStream<Uint8Array>(),
          config: { encoding: "MULAW", sampleRate: 8000, channels: 1, conversationId: "c1" },
          filetype: "wav",
        };

        await adapter.streamAudio!(audioInput as any, hooks, defaultOptions);

        // TTS error should be logged, not swallowed
        const warnCalls = (warnSpy as any).mock.calls;
        const ttsWarn = warnCalls.find((args: any[]) =>
          typeof args[0] === "string" && args[0].includes("TTS failed")
        );
        expect(ttsWarn).toBeDefined();
        // onFinish should still fire even when TTS fails
        expect(hooks.finishCount).toBe(1);
      } finally {
        console.warn = origWarn;
      }
    });
  });

  describe("getConfig", () => {
    test("returns string instructions as systemPrompt", () => {
      const agent = new Agent({
        id: "test",
        name: "Test",
        model: modelFromParts(textParts(["hi"])),
        instructions: "You are a helpful assistant.",
      });
      const adapter = new MastraAdapter(agent);
      const config = adapter.getConfig();

      expect(config.systemPrompt).toBe("You are a helpful assistant.");
    });

    test("joins array instructions with double newline", () => {
      const agent = new Agent({
        id: "test",
        name: "Test",
        model: modelFromParts(textParts(["hi"])),
        instructions: ["Be helpful.", "Be concise."],
      });
      const adapter = new MastraAdapter(agent);
      const config = adapter.getConfig();

      expect(config.systemPrompt).toBe("Be helpful.\n\nBe concise.");
    });

    test("returns empty tools when no tools configured", () => {
      const agent = new Agent({
        id: "test",
        name: "Test",
        model: modelFromParts(textParts(["hi"])),
        instructions: "test",
      });
      const adapter = new MastraAdapter(agent);
      const config = adapter.getConfig();

      expect(config.tools).toEqual([]);
    });

    test("maps configured tools to tool configs", () => {
      const weatherTool = createTool({
        id: "weather",
        description: "Get current weather",
        inputSchema: z.object({ location: z.string() }),
        execute: async () => ({ temp: "72F" }),
      });

      const agent = new Agent({
        id: "test",
        name: "Test",
        model: modelFromParts(textParts(["hi"])),
        instructions: "test",
        tools: { weather: weatherTool },
      });
      const adapter = new MastraAdapter(agent);
      const config = adapter.getConfig();

      expect(config.tools).toHaveLength(1);
      expect(config.tools[0].name).toBe("weather");
      expect(config.tools[0].description).toBe("Get current weather");
      expect(config.tools[0].type).toBe("other");
    });
  });
});
