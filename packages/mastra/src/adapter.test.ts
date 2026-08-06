import { describe, test, expect, mock, beforeEach } from "bun:test";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  MastraLanguageModelV2Mock,
  simulateReadableStream,
} from "@mastra/core/test-utils/llm-mock";
import type { LanguageModelV2StreamPart } from "@ai-sdk/provider-v5";
import type { StatusUpdate } from "@astropods/messaging";
import type { StreamOptions, TraceContext } from "@astropods/adapter-core";
let mockLoggerWarnCalls: any[][] = [];

class UnsupportedRenderableError extends Error {
  constructor(public readonly renderableId: string) {
    super(`Renderable ${renderableId} could not be rendered`);
    this.name = "UnsupportedRenderableError";
  }
}

mock.module("@astropods/adapter-core", () => ({
  createTraceparent: ({ traceId, spanId, traceFlags = "01" }: { traceId?: string; spanId?: string; traceFlags?: string | number }) => {
    if (!traceId || !spanId) return "";
    const flags = typeof traceFlags === "number" ? traceFlags.toString(16).padStart(2, "0") : traceFlags;
    return `00-${traceId.toLowerCase()}-${spanId.toLowerCase()}-${flags}`;
  },
  UnsupportedRenderableError,
  logger: {
    info: () => {},
    debug: () => {},
    error: () => {},
    warn: (...args: any[]) => { mockLoggerWarnCalls.push(args); },
  },
}));

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
    traceContexts: [] as TraceContext[],
    onTraceContext(traceContext: TraceContext) { result.traceContexts.push(traceContext); },
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

// A stand-in for a Mastra stream segment: the runId used to resume, and a
// fullStream yielding the given chunks. Used to drive the approval/suspend
// paths without a live model.
function segment(runId: string | undefined, chunks: Array<{ type: string; payload?: any }>) {
  return {
    runId,
    fullStream: (async function* () {
      for (const chunk of chunks) yield chunk;
    })(),
  };
}

const textThenFinish = (text: string) => [
  { type: "text-delta", payload: { text } },
  { type: "finish", payload: {} },
];

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

    test("emits trace context when Mastra stream exposes trace IDs", async () => {
      const agent = new Agent({
        id: "test",
        name: "Test",
        model: modelFromParts(textParts(["Hello"])),
        instructions: "test",
      });
      const fullStream = (async function* () {
        yield { type: "text-delta", payload: { text: "Hello" } };
        yield { type: "finish" };
      })();
      const originalStream = agent.stream.bind(agent);
      (agent as { stream: typeof originalStream }).stream = mock(async () => ({
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
        fullStream,
      })) as unknown as typeof originalStream;

      const adapter = new MastraAdapter(agent);
      const hooks = createHooks();

      await adapter.stream("hi", hooks, defaultOptions);

      expect(hooks.traceContexts).toEqual([
        {
          traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        },
      ]);
      expect(hooks.chunks).toEqual(["Hello"]);
      expect(hooks.finishCount).toBe(1);
    });

    test("builds a multimodal message when the turn carries images", async () => {
      const agent = new Agent({
        id: "test",
        name: "Test",
        model: modelFromParts(textParts(["ok"])),
        instructions: "test",
      });
      let capturedInput: unknown;
      const fullStream = (async function* () {
        yield { type: "finish" };
      })();
      const originalStream = agent.stream.bind(agent);
      (agent as { stream: typeof originalStream }).stream = mock(
        async (input: unknown) => {
          capturedInput = input;
          return { fullStream } as unknown as Awaited<ReturnType<typeof originalStream>>;
        }
      ) as unknown as typeof originalStream;

      const adapter = new MastraAdapter(agent);
      const hooks = createHooks();

      await adapter.stream("what is this?", hooks, {
        ...defaultOptions,
        images: [
          { name: "shot.png", url: "data:image/png;base64,AAAA", mimeType: "image/png" },
        ],
      });

      expect(capturedInput).toEqual([
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image", image: "data:image/png;base64,AAAA", mediaType: "image/png" },
          ],
        },
      ]);
    });

    test("derives image mediaType from the data URI when mimeType is absent", async () => {
      const agent = new Agent({
        id: "test",
        name: "Test",
        model: modelFromParts(textParts(["ok"])),
        instructions: "test",
      });
      let capturedInput: unknown;
      const fullStream = (async function* () {
        yield { type: "finish" };
      })();
      const originalStream = agent.stream.bind(agent);
      (agent as { stream: typeof originalStream }).stream = mock(
        async (input: unknown) => {
          capturedInput = input;
          return { fullStream } as unknown as Awaited<ReturnType<typeof originalStream>>;
        }
      ) as unknown as typeof originalStream;

      const adapter = new MastraAdapter(agent);
      const hooks = createHooks();

      await adapter.stream("what is this?", hooks, {
        ...defaultOptions,
        images: [{ name: "shot.webp", url: "data:image/webp;base64,AAAA" }],
      });

      expect(capturedInput).toEqual([
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image", image: "data:image/webp;base64,AAAA", mediaType: "image/webp" },
          ],
        },
      ]);
    });

    test("passes a plain string prompt when the turn has no images", async () => {
      const agent = new Agent({
        id: "test",
        name: "Test",
        model: modelFromParts(textParts(["ok"])),
        instructions: "test",
      });
      let capturedInput: unknown;
      const fullStream = (async function* () {
        yield { type: "finish" };
      })();
      const originalStream = agent.stream.bind(agent);
      (agent as { stream: typeof originalStream }).stream = mock(
        async (input: unknown) => {
          capturedInput = input;
          return { fullStream } as unknown as Awaited<ReturnType<typeof originalStream>>;
        }
      ) as unknown as typeof originalStream;

      const adapter = new MastraAdapter(agent);
      const hooks = createHooks();

      await adapter.stream("just text", hooks, defaultOptions);

      expect(capturedInput).toBe("just text");
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

    test("empty userId backfills tracing user_id to 'anonymous' but leaves memory.resource untouched", async () => {
      // Unauthenticated Slack user → empty userId on the bridge. Tracing must
      // still set a non-empty user_id so the trace classifies as Unauthorized
      // in Insights, not Unattributed (the latter is for cron / SDK / ingestion).
      const agent = new Agent({
        id: "test",
        name: "Test",
        model: modelFromParts(textParts(["hi"])),
        instructions: "test",
      });
      const originalStream = agent.stream.bind(agent);
      const spy = mock((...args: Parameters<typeof originalStream>) => originalStream(...args));
      (agent as { stream: typeof originalStream }).stream = spy as unknown as typeof originalStream;

      const adapter = new MastraAdapter(agent);
      const hooks = createHooks();
      await adapter.stream("hi", hooks, { conversationId: "conv-1", userId: "" });

      const callOpts = spy.mock.calls[0]?.[1] as {
        memory?: { resource?: string };
        tracingOptions?: { metadata?: Record<string, string> };
      };
      expect(callOpts?.tracingOptions?.metadata?.["langfuse.user.id"]).toBe("anonymous");
      expect(callOpts?.memory?.resource).toBe("");
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
      mockLoggerWarnCalls = [];

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
      const ttsWarn = mockLoggerWarnCalls.find((args) =>
        typeof args[1] === "string" && args[1].includes("TTS failed")
      );
      expect(ttsWarn).toBeDefined();
      // onFinish should still fire even when TTS fails
      expect(hooks.finishCount).toBe(1);
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

  describe("stop-generation (abort)", () => {
    test("forwards the abort signal to agent.stream", async () => {
      const agent = new Agent({
        id: "test",
        name: "Test",
        model: modelFromParts(textParts(["hi"])),
        instructions: "test",
      });
      const originalStream = agent.stream.bind(agent);
      const spy = mock((...args: Parameters<typeof originalStream>) => originalStream(...args));
      (agent as { stream: typeof originalStream }).stream = spy as unknown as typeof originalStream;

      const adapter = new MastraAdapter(agent);
      const hooks = createHooks();
      const controller = new AbortController();

      await adapter.stream("hi", hooks, {
        conversationId: "conv-1",
        userId: "user-1",
        signal: controller.signal,
      });

      const callOpts = spy.mock.calls[0]?.[1] as { abortSignal?: AbortSignal };
      expect(callOpts?.abortSignal).toBe(controller.signal);
    });

    test("an already-aborted signal stops consuming fullStream before emitting anything", async () => {
      const agent = new Agent({
        id: "test",
        name: "Test",
        model: modelFromParts(textParts(["hi"])),
        instructions: "test",
      });

      async function* fullStream() {
        yield { type: "text-delta", payload: { text: "should-not-appear" } };
        yield { type: "finish", payload: {} };
      }
      (agent as unknown as { stream: unknown }).stream = mock(async () => ({
        fullStream: fullStream(),
      }));

      const adapter = new MastraAdapter(agent);
      const hooks = createHooks();
      const controller = new AbortController();
      controller.abort(); // aborted before streaming begins

      await adapter.stream("hi", hooks, {
        conversationId: "conv-1",
        userId: "user-1",
        signal: controller.signal,
      });

      expect(hooks.chunks).toEqual([]);
      expect(hooks.finishCount).toBe(0);
      expect(hooks.errors).toEqual([]);
    });

    test("aborting mid-stream stops further chunks and suppresses the trailing finish", async () => {
      const agent = new Agent({
        id: "test",
        name: "Test",
        model: modelFromParts(textParts(["hi"])),
        instructions: "test",
      });

      const controller = new AbortController();
      async function* fullStream() {
        yield { type: "text-delta", payload: { text: "first" } };
        controller.abort(); // user stops after the first token
        yield { type: "text-delta", payload: { text: "second" } };
        yield { type: "finish", payload: {} };
      }
      (agent as unknown as { stream: unknown }).stream = mock(async () => ({
        fullStream: fullStream(),
      }));

      const adapter = new MastraAdapter(agent);
      const hooks = createHooks();

      await adapter.stream("hi", hooks, {
        conversationId: "conv-1",
        userId: "user-1",
        signal: controller.signal,
      });

      // Only the pre-abort token is emitted; the post-abort chunk and the
      // finish are dropped by the guard.
      expect(hooks.chunks).toEqual(["first"]);
      expect(hooks.finishCount).toBe(0);
      expect(hooks.errors).toEqual([]);
    });
  });

  describe("tool permission (approval)", () => {
    function agentWithApproval(pausePayload: Record<string, any>, continuation: any[]) {
      const agent = new Agent({
        id: "t", name: "T", model: modelFromParts(textParts(["x"])), instructions: "t",
      });
      const streamMock = mock(async () =>
        segment("run-1", [{ type: "tool-call-approval", payload: pausePayload }])
      );
      const approve = mock(async () => segment("run-1", continuation));
      const decline = mock(async () => segment("run-1", continuation));
      (agent as any).stream = streamMock;
      (agent as any).approveToolCall = approve;
      (agent as any).declineToolCall = decline;
      return { agent, approve, decline };
    }

    const payload = { toolCallId: "tc-1", toolName: "deleteRecord", args: { id: "abc" }, resumeSchema: "" };

    test("renders a tool_permission Renderable and approves on SUBMIT", async () => {
      const { agent, approve, decline } = agentWithApproval(payload, textThenFinish("deleted"));
      const adapter = new MastraAdapter(agent);
      const hooks = createHooks();
      const render = mock(async () => ({ id: "r", action: "RENDERABLE_ACTION_SUBMIT" }));

      await adapter.stream("delete abc", hooks, { ...defaultOptions, render });

      expect(render).toHaveBeenCalledTimes(1);
      const input = render.mock.calls[0][0] as any;
      expect(input.intent).toBe("tool_permission");
      expect(input.value).toEqual({ id: "abc" });
      // Tool name → schema title (client heading); args → plain-text subtext.
      expect(input.dataSchema.title).toBe("deleteRecord");
      expect(input.message).toContain("id: abc");
      expect(input.allowedActions).toEqual(["RENDERABLE_ACTION_SUBMIT", "RENDERABLE_ACTION_DECLINE"]);
      expect(approve).toHaveBeenCalledTimes(1);
      expect(approve.mock.calls[0][0]).toMatchObject({ runId: "run-1", toolCallId: "tc-1" });
      expect(decline).not.toHaveBeenCalled();
      expect(hooks.chunks).toEqual(["deleted"]);
      expect(hooks.finishCount).toBe(1);
    });

    test("declines on DECLINE, letting the agent continue", async () => {
      const { agent, approve, decline } = agentWithApproval(payload, textThenFinish("won't do it"));
      const adapter = new MastraAdapter(agent);
      const hooks = createHooks();
      const render = mock(async () => ({ id: "r", action: "RENDERABLE_ACTION_DECLINE" }));

      await adapter.stream("delete abc", hooks, { ...defaultOptions, render });

      expect(decline).toHaveBeenCalledTimes(1);
      expect(decline.mock.calls[0][0]).toMatchObject({ runId: "run-1", toolCallId: "tc-1" });
      expect(approve).not.toHaveBeenCalled();
      expect(hooks.chunks).toEqual(["won't do it"]);
      expect(hooks.finishCount).toBe(1);
    });

    test("treats CANCEL as a decline", async () => {
      const { agent, approve, decline } = agentWithApproval(payload, textThenFinish("ok"));
      const adapter = new MastraAdapter(agent);
      const hooks = createHooks();
      const render = mock(async () => ({ id: "r", action: "RENDERABLE_ACTION_CANCEL" }));

      await adapter.stream("delete abc", hooks, { ...defaultOptions, render });

      expect(decline).toHaveBeenCalledTimes(1);
      expect(approve).not.toHaveBeenCalled();
    });

    test("declines when no render surface is available", async () => {
      const { agent, approve, decline } = agentWithApproval(payload, textThenFinish("ok"));
      const adapter = new MastraAdapter(agent);
      const hooks = createHooks();

      await adapter.stream("delete abc", hooks, defaultOptions);

      expect(decline).toHaveBeenCalledTimes(1);
      expect(approve).not.toHaveBeenCalled();
    });

    test("declines when the surface cannot render (UnsupportedRenderableError)", async () => {
      const { agent, approve, decline } = agentWithApproval(payload, textThenFinish("ok"));
      const adapter = new MastraAdapter(agent);
      const hooks = createHooks();
      const render = mock(async () => { throw new UnsupportedRenderableError("r"); });

      await adapter.stream("delete abc", hooks, { ...defaultOptions, render });

      expect(decline).toHaveBeenCalledTimes(1);
      expect(approve).not.toHaveBeenCalled();
    });
  });

  describe("input elicitation (suspend)", () => {
    const resumeSchema = JSON.stringify({ type: "object", properties: { city: { type: "string" } } });
    function agentWithSuspend(pausePayload: Record<string, any>, continuation: any[]) {
      const agent = new Agent({
        id: "t", name: "T", model: modelFromParts(textParts(["x"])), instructions: "t",
      });
      (agent as any).stream = mock(async () =>
        segment("run-2", [{ type: "tool-call-suspended", payload: pausePayload }])
      );
      const resume = mock(async () => segment("run-2", continuation));
      (agent as any).resumeStream = resume;
      return { agent, resume };
    }

    const payload = {
      toolCallId: "tc-9", toolName: "weather", args: {},
      suspendPayload: { message: "Which city?" }, resumeSchema,
    };

    test("elicits with the tool's resumeSchema and resumes on SUBMIT", async () => {
      const { agent, resume } = agentWithSuspend(payload, textThenFinish("72F"));
      const adapter = new MastraAdapter(agent);
      const hooks = createHooks();
      const elicit = mock(async () => ({
        id: "e", action: "RENDERABLE_ACTION_SUBMIT", contentJson: JSON.stringify({ city: "SF" }),
      }));

      await adapter.stream("weather", hooks, { ...defaultOptions, elicit });

      expect(elicit).toHaveBeenCalledTimes(1);
      expect(elicit.mock.calls[0][0]).toBe("Which city?");
      expect(elicit.mock.calls[0][1]).toMatchObject({ type: "object", properties: { city: { type: "string" } } });
      // A "write your own reply" option is offered alongside the form.
      expect(elicit.mock.calls[0][2].allowedActions).toContain("RENDERABLE_ACTION_RESPOND");
      expect(resume).toHaveBeenCalledTimes(1);
      expect(resume.mock.calls[0][0]).toEqual({ city: "SF" });
      expect(resume.mock.calls[0][1]).toMatchObject({ runId: "run-2", toolCallId: "tc-9" });
      expect(hooks.chunks).toEqual(["72F"]);
      expect(hooks.finishCount).toBe(1);
    });

    test("aborts the turn on CANCEL without resuming", async () => {
      const { agent, resume } = agentWithSuspend(payload, textThenFinish("unused"));
      const adapter = new MastraAdapter(agent);
      const hooks = createHooks();
      const elicit = mock(async () => ({ id: "e", action: "RENDERABLE_ACTION_CANCEL" }));

      await adapter.stream("weather", hooks, { ...defaultOptions, elicit });

      expect(resume).not.toHaveBeenCalled();
      expect(hooks.chunks).toEqual([]);
      expect(hooks.finishCount).toBe(1);
    });

    test("falls back to a generic prompt when suspendPayload carries no message", async () => {
      const { agent } = agentWithSuspend({ ...payload, suspendPayload: {} }, textThenFinish("x"));
      const adapter = new MastraAdapter(agent);
      const hooks = createHooks();
      const elicit = mock(async () => ({ id: "e", action: "RENDERABLE_ACTION_CANCEL" }));

      await adapter.stream("weather", hooks, { ...defaultOptions, elicit });

      expect(elicit.mock.calls[0][0]).toBe("The agent needs more information to continue.");
    });

    test("aborts the turn when no elicit surface is available", async () => {
      const { agent, resume } = agentWithSuspend(payload, textThenFinish("unused"));
      const adapter = new MastraAdapter(agent);
      const hooks = createHooks();

      await adapter.stream("weather", hooks, defaultOptions);

      expect(resume).not.toHaveBeenCalled();
      expect(hooks.finishCount).toBe(1);
    });

    test("does not re-feed on RESPOND — the surface owns the follow-up turn", async () => {
      const agent = new Agent({
        id: "t", name: "T", model: modelFromParts(textParts(["x"])), instructions: "t",
      });
      const streamMock = mock(async () =>
        segment("run-2", [{ type: "tool-call-suspended", payload }])
      );
      const resume = mock(async () => segment("run-2", textThenFinish("unused")));
      (agent as any).stream = streamMock;
      (agent as any).resumeStream = resume;

      const adapter = new MastraAdapter(agent);
      const hooks = createHooks();
      const elicit = mock(async () => ({
        id: "e", action: "RENDERABLE_ACTION_RESPOND", text: "Tuesday at 2pm for 4",
      }));

      await adapter.stream("schedule", hooks, { ...defaultOptions, elicit });

      // RESPOND aborts this turn; the surface re-injects the prose as a new turn,
      // so the adapter must not re-feed (no second stream, no resume).
      expect(streamMock).toHaveBeenCalledTimes(1);
      expect(resume).not.toHaveBeenCalled();
      expect(hooks.chunks).toEqual([]);
      expect(hooks.finishCount).toBe(1);
    });
  });
});
