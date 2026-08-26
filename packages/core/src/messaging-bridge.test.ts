import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { AgentAdapter, StreamHooks, StreamOptions } from "./types";
import type {
  AgentConfig,
  AgentResponse,
  AudioStreamConfig,
  ContentChunk,
  Message,
  StatusUpdate,
} from "@astropods/messaging";

// --- Mock state ---

let mockConnectCalled = false;
let mockHealthCheckCalled = false;
let mockCloseCalled = false;
let mockStreamEndCalled = false;
let mockSendAgentConfigArgs: AgentConfig | null = null;
let mockSendMessageArgs: Message | null = null;
let mockSendContentChunkCalls: Array<{
  conversationId: string;
  chunk: ContentChunk;
  response?: Pick<AgentResponse, "responseId" | "traceContext">;
}> = [];
let mockSendStatusUpdateCalls: Array<{
  conversationId: string;
  status: StatusUpdate;
  response?: Pick<AgentResponse, "responseId" | "traceContext">;
}> = [];
let mockSendAgentResponseCalls: AgentResponse[] = [];
let mockResponseHandlers: Array<(response: AgentResponse) => void> = [];
let mockErrorHandlers: Array<(error: Error) => void> = [];
let mockEndHandlers: Array<() => void> = [];
let mockAudioConfigHandlers: Array<(config: AudioStreamConfig) => void> = [];
let mockConstructorAddr: string | null = null;
let mockSendTranscriptCalls: Array<{
  conversationId: string;
  text: string;
  response?: Pick<AgentResponse, "responseId" | "traceContext">;
}> = [];
let mockSendAudioChunkCalls: Array<{ data: Uint8Array; done: boolean }> = [];
let mockEndAudioCalled = false;
let mockSendSaveConversationCalls: Array<any> = [];

// --- Mock messaging SDK ---

mock.module("@astropods/messaging", () => ({
  audioEncodingToFiletype: (encoding: string) => encoding === "MULAW" ? "wav" : encoding.toLowerCase(),
  MessagingClient: class MockMessagingClient {
    constructor(addr: string) {
      mockConstructorAddr = addr;
    }
    async connect() {
      mockConnectCalled = true;
    }
    async healthCheck() {
      mockHealthCheckCalled = true;
      return { status: "SERVING" };
    }
    createConversationStream() {
      return {
        sendAgentConfig(config: AgentConfig) {
          mockSendAgentConfigArgs = config;
        },
        sendMessage(msg: Message) {
          mockSendMessageArgs = msg;
        },
        sendContentChunk(
          conversationId: string,
          chunk: ContentChunk,
          response?: Pick<AgentResponse, "responseId" | "traceContext">,
        ) {
          mockSendContentChunkCalls.push({ conversationId, chunk, response });
        },
        sendStatusUpdate(
          conversationId: string,
          status: StatusUpdate,
          response?: Pick<AgentResponse, "responseId" | "traceContext">,
        ) {
          mockSendStatusUpdateCalls.push({ conversationId, status, response });
        },
        sendAgentResponse(response: AgentResponse) {
          mockSendAgentResponseCalls.push(response);
        },
        sendTranscript(
          conversationId: string,
          text: string,
          _messageId?: string,
          _language?: string,
          response?: Pick<AgentResponse, "responseId" | "traceContext">,
        ) {
          mockSendTranscriptCalls.push({ conversationId, text, response });
        },
        sendAudioChunk(chunk: { data: Uint8Array; done: boolean }) {
          mockSendAudioChunkCalls.push(chunk);
        },
        sendSaveConversation(save: any) {
          mockSendSaveConversationCalls.push(save);
          return "derived-conversation-id";
        },
        endAudio() {
          mockEndAudioCalled = true;
        },
        audioAsReadable() {
          return new ReadableStream<Uint8Array>();
        },
        on(event: string, handler: any) {
          if (event === "response") mockResponseHandlers.push(handler);
          if (event === "error") mockErrorHandlers.push(handler);
          if (event === "end") mockEndHandlers.push(handler);
          if (event === "audioConfig") mockAudioConfigHandlers.push(handler);
        },
        end() {
          mockStreamEndCalled = true;
        },
      };
    }
    close() {
      mockCloseCalled = true;
    }
  },
  Helpers: {
    createContentResponse(conversationId: string, content: string, final: boolean) {
      return { conversationId, content: { type: final ? "END" : "START", content } };
    },
    createStatusResponse(conversationId: string, status: string, message?: string) {
      return { conversationId, status: { status, customMessage: message } };
    },
    createErrorResponse(conversationId: string, code: string, message: string) {
      return { conversationId, error: { code, message } };
    },
  },
}));

let mockLoggerDebugCalls: string[] = [];

mock.module("./logger", () => ({
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: (msg: string) => { mockLoggerDebugCalls.push(msg); },
  },
}));

const { MessagingBridge, UnsupportedRenderableError } = await import("./messaging-bridge");

// --- Helpers ---

function createMockAdapter(overrides?: Partial<AgentAdapter>): AgentAdapter {
  return {
    name: "Test Agent",
    stream: async () => {},
    getConfig: () => ({
      systemPrompt: "You are a test agent.",
      tools: [{ name: "testTool", title: "Test Tool", description: "A tool", type: "other" }],
    }),
    ...overrides,
  };
}

function resetMockState() {
  mockConnectCalled = false;
  mockHealthCheckCalled = false;
  mockCloseCalled = false;
  mockStreamEndCalled = false;
  mockSendSaveConversationCalls = [];
  mockSendAgentConfigArgs = null;
  mockSendMessageArgs = null;
  mockSendContentChunkCalls = [];
  mockSendStatusUpdateCalls = [];
  mockSendAgentResponseCalls = [];
  mockResponseHandlers = [];
  mockErrorHandlers = [];
  mockEndHandlers = [];
  mockAudioConfigHandlers = [];
  mockConstructorAddr = null;
  mockSendTranscriptCalls = [];
  mockSendAudioChunkCalls = [];
  mockEndAudioCalled = false;
  mockLoggerDebugCalls = [];
}

// --- Tests ---

describe("MessagingBridge", () => {
  beforeEach(resetMockState);

  describe("constructor", () => {
    test("uses serverAddress from options when provided", () => {
      const adapter = createMockAdapter();
      const bridge = new MessagingBridge(adapter, { serverAddress: "custom:1234" });
      // Address is stored privately, verified indirectly via start()
      expect(bridge).toBeDefined();
    });

    test("falls back to GRPC_SERVER_ADDR env var", () => {
      const originalEnv = process.env.GRPC_SERVER_ADDR;
      process.env.GRPC_SERVER_ADDR = "env-server:5555";
      try {
        const adapter = createMockAdapter();
        const bridge = new MessagingBridge(adapter);
        expect(bridge).toBeDefined();
      } finally {
        if (originalEnv === undefined) {
          delete process.env.GRPC_SERVER_ADDR;
        } else {
          process.env.GRPC_SERVER_ADDR = originalEnv;
        }
      }
    });
  });

  describe("start", () => {
    test("connects to messaging service and performs health check", async () => {
      const adapter = createMockAdapter();
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });

      await bridge.start();

      expect(mockConnectCalled).toBe(true);
      expect(mockHealthCheckCalled).toBe(true);
    });

    test("passes server address to MessagingClient", async () => {
      const adapter = createMockAdapter();
      const bridge = new MessagingBridge(adapter, { serverAddress: "myhost:4444" });

      await bridge.start();

      expect(mockConstructorAddr).toBe("myhost:4444");
    });

    test("sends agent config to the stream", async () => {
      const config = {
        systemPrompt: "Custom prompt",
        tools: [{ name: "myTool", title: "My Tool", description: "desc", type: "other" }],
      };
      const adapter = createMockAdapter({ getConfig: () => config });
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });

      await bridge.start();

      expect(mockSendAgentConfigArgs).toEqual(config);
    });

    test("registers agent with correct id derived from name", async () => {
      const adapter = createMockAdapter({ name: "My Cool Agent" });
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });

      await bridge.start();

      expect(mockSendMessageArgs).toBeDefined();
      expect(mockSendMessageArgs!.user.id).toBe("my-cool-agent");
      expect(mockSendMessageArgs!.user.username).toBe("My Cool Agent");
      expect(mockSendMessageArgs!.conversationId).toBe("agent-registration");
      expect(mockSendMessageArgs!.platform).toBe("grpc");
      expect(mockSendMessageArgs!.content).toBe("Agent ready");
    });

    test("registers response, error, and end event handlers", async () => {
      const adapter = createMockAdapter();
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });

      await bridge.start();

      expect(mockResponseHandlers).toHaveLength(1);
      expect(mockErrorHandlers).toHaveLength(1);
      expect(mockEndHandlers).toHaveLength(1);
    });
  });

  describe("message handling", () => {
    test("ignores responses without incomingMessage", async () => {
      const streamFn = mock(async () => {});
      const adapter = createMockAdapter({ stream: streamFn });
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });

      await bridge.start();

      // Fire a response with no incoming message (e.g. a status update from server)
      mockResponseHandlers[0]({ conversationId: "conv-1" });

      expect(streamFn).not.toHaveBeenCalled();
    });

    test("sends START chunk before streaming and END chunk on finish", async () => {
      let capturedHooks: StreamHooks | null = null;

      const adapter = createMockAdapter({
        stream: async (_prompt, hooks) => {
          capturedHooks = hooks;
          hooks.onFinish();
        },
      });
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });

      await bridge.start();

      mockResponseHandlers[0]({
        conversationId: "conv-1",
        incomingMessage: {
          conversationId: "conv-1",
          content: "hello",
          platform: "slack",
          user: { id: "user-1", username: "Alice" },
        },
      });

      // Allow async stream call to complete
      await new Promise((r) => setTimeout(r, 10));

      // First call: START
      expect(mockSendContentChunkCalls[0]).toEqual({
        conversationId: "conv-1",
        chunk: { type: "START", content: "" },
        response: undefined,
      });
      // Last call: END
      const lastChunk = mockSendContentChunkCalls[mockSendContentChunkCalls.length - 1];
      expect(lastChunk).toEqual({
        conversationId: "conv-1",
        chunk: { type: "END", content: "" },
        response: undefined,
      });
    });

    test("passes inbound FILE attachments to the adapter as StreamOptions.attachments", async () => {
      let capturedOptions: StreamOptions | null = null;
      const adapter = createMockAdapter({
        stream: async (_prompt, hooks, options) => {
          capturedOptions = options;
          hooks.onFinish();
        },
      });
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });
      await bridge.start();

      mockResponseHandlers[0]({
        conversationId: "conv-1",
        incomingMessage: {
          conversationId: "conv-1",
          content: "process this",
          platform: "web",
          user: { id: "user-1" },
          attachments: [
            {
              type: "FILE",
              filename: "data.csv",
              mimeType: "text/csv",
              sizeBytes: 2044,
              storageKey: "uuid-1",
            },
            // No storage key (older sidecar/proto): the filename can't locate the
            // blob, so `path` must be omitted rather than guessed.
            { type: "FILE", filename: "legacy.txt", mimeType: "text/plain" },
            // A non-file attachment (e.g. image) is ignored by resolveAttachments.
            { type: "IMAGE", filename: "pic.png" },
          ],
        },
      });

      await new Promise((r) => setTimeout(r, 10));

      const atts = capturedOptions!.attachments ?? [];
      expect(atts).toHaveLength(2);
      // With a storage key, the path resolves to the on-disk blob.
      expect(atts[0]).toEqual({
        key: "uuid-1",
        name: "data.csv",
        path: "/data/files/uuid-1.blob",
        mimeType: "text/csv",
        size: 2044,
      });
      // Without a storage key, path is omitted (not a filename-based guess).
      expect(atts[1].path).toBeUndefined();
      expect(atts[1].key).toBe("legacy.txt");
    });

    test("passes inbound IMAGE attachments to the adapter as StreamOptions.images", async () => {
      let capturedOptions: StreamOptions | null = null;
      const adapter = createMockAdapter({
        stream: async (_prompt, hooks, options) => {
          capturedOptions = options;
          hooks.onFinish();
        },
      });
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });
      await bridge.start();

      mockResponseHandlers[0]({
        conversationId: "conv-1",
        incomingMessage: {
          conversationId: "conv-1",
          content: "what's in this image?",
          platform: "slack",
          user: { id: "user-1" },
          attachments: [
            {
              type: "IMAGE",
              filename: "shot.png",
              mimeType: "image/png",
              sizeBytes: 123,
              url: "data:image/png;base64,AAAA",
            },
            // An image without a url can't be forwarded inline, so it's skipped.
            { type: "IMAGE", filename: "no-url.png", mimeType: "image/png" },
            // Files go to attachments, never images.
            { type: "FILE", filename: "data.csv", storageKey: "uuid-1" },
          ],
        },
      });

      await new Promise((r) => setTimeout(r, 10));

      const imgs = capturedOptions!.images ?? [];
      expect(imgs).toHaveLength(1);
      expect(imgs[0]).toEqual({
        name: "shot.png",
        url: "data:image/png;base64,AAAA",
        mimeType: "image/png",
        size: 123,
      });
      // Files still resolve to attachments, not images.
      expect((capturedOptions!.attachments ?? []).map((a) => a.key)).toEqual([
        "uuid-1",
      ]);
    });

    test("delivers agent-produced files on the END chunk via onFile", async () => {
      const adapter = createMockAdapter({
        stream: async (_prompt, hooks) => {
          hooks.onChunk("done");
          hooks.onFile({ name: "processed.txt", mimeType: "text/plain", size: 12 });
          hooks.onFinish();
        },
      });
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });
      await bridge.start();

      mockResponseHandlers[0]({
        conversationId: "conv-1",
        incomingMessage: {
          conversationId: "conv-1",
          content: "go",
          platform: "web",
          user: { id: "user-1" },
        },
      });

      await new Promise((r) => setTimeout(r, 10));

      const end = mockSendContentChunkCalls.find((c) => c.chunk.type === "END");
      expect(end).toBeDefined();
      expect(end!.chunk.attachments).toEqual([
        { file: { filename: "processed.txt", mimeType: "text/plain", sizeBytes: 12 } },
      ]);
    });

    test("sends DELTA chunks for each onChunk call", async () => {
      const adapter = createMockAdapter({
        stream: async (_prompt, hooks) => {
          hooks.onChunk("Hello");
          hooks.onChunk(" world");
          hooks.onFinish();
        },
      });
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });

      await bridge.start();

      mockResponseHandlers[0]({
        conversationId: "conv-1",
        incomingMessage: {
          conversationId: "conv-1",
          content: "hi",
          platform: "slack",
          user: { id: "user-1" },
        },
      });

      await new Promise((r) => setTimeout(r, 10));

      const deltas = mockSendContentChunkCalls.filter(
        (c) => c.chunk.type === "DELTA"
      );
      expect(deltas).toHaveLength(2);
      expect(deltas[0].chunk.content).toBe("Hello");
      expect(deltas[1].chunk.content).toBe(" world");
    });

    test("attaches trace context to content chunks once the hook fires", async () => {
      const traceContext = {
        traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
      };
      const adapter = createMockAdapter({
        stream: async (_prompt, hooks) => {
          hooks.onTraceContext?.(traceContext);
          hooks.onChunk("Hello");
          hooks.onFinish();
        },
      });
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });

      await bridge.start();

      mockResponseHandlers[0]({
        conversationId: "conv-1",
        incomingMessage: {
          conversationId: "conv-1",
          content: "hi",
          platform: "slack",
          user: { id: "user-1" },
        },
      });

      await new Promise((r) => setTimeout(r, 10));

      // START is sent before the hook fires (no trace context); the DELTA and
      // END that follow carry it via the content sender's response arg.
      expect(mockSendContentChunkCalls).toEqual([
        {
          conversationId: "conv-1",
          chunk: { type: "START", content: "" },
          response: undefined,
        },
        {
          conversationId: "conv-1",
          chunk: { type: "DELTA", content: "Hello" },
          response: { traceContext },
        },
        {
          conversationId: "conv-1",
          chunk: { type: "END", content: "" },
          response: { traceContext },
        },
      ]);
    });

    test("a superseded turn's cleanup does not wipe the new turn's trace context", async () => {
      const ctxB = {
        traceparent: "00-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-bbbbbbbbbbbbbbbb-01",
      };
      let call = 0;
      const adapter = createMockAdapter({
        stream: async (_prompt, hooks, options) => {
          call += 1;
          if (call === 1) {
            hooks.onTraceContext?.({
              traceparent:
                "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-aaaaaaaaaaaaaaaa-01",
            });
            // Hang until superseded; settle on abort so this turn's finally
            // runs while turn B is mid-stream.
            await new Promise<void>((resolve) => {
              options.signal?.addEventListener("abort", () => resolve());
            });
            return;
          }
          hooks.onTraceContext?.(ctxB);
          // Yield so turn A's abort → finally runs before B emits its chunk.
          await new Promise((r) => setTimeout(r, 10));
          hooks.onChunk("from B");
          hooks.onFinish();
        },
      });
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });
      await bridge.start();

      const message = {
        conversationId: "conv-1",
        incomingMessage: {
          conversationId: "conv-1",
          content: "hi",
          platform: "slack",
          user: { id: "user-1" },
        },
      };

      mockResponseHandlers[0](message); // turn A: sets its context, hangs
      await new Promise((r) => setTimeout(r, 5));
      mockResponseHandlers[0](message); // turn B: supersedes A, sets ctxB
      await new Promise((r) => setTimeout(r, 30));

      const bChunks = mockSendContentChunkCalls.filter(
        (c) => c.chunk.type !== "START",
      );
      expect(bChunks.length).toBeGreaterThan(0);
      for (const c of bChunks) {
        expect(c.response?.traceContext).toEqual(ctxB);
      }
    });

    test("sends status updates via sendStatusUpdate", async () => {
      const adapter = createMockAdapter({
        stream: async (_prompt, hooks) => {
          hooks.onStatusUpdate({ status: "THINKING" });
          hooks.onStatusUpdate({ status: "PROCESSING", customMessage: "Running tool" });
          hooks.onFinish();
        },
      });
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });

      await bridge.start();

      mockResponseHandlers[0]({
        conversationId: "conv-1",
        incomingMessage: {
          conversationId: "conv-1",
          content: "test",
          platform: "slack",
          user: { id: "user-1" },
        },
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(mockSendStatusUpdateCalls).toHaveLength(2);
      expect(mockSendStatusUpdateCalls[0]).toEqual({
        conversationId: "conv-1",
        status: { status: "THINKING" },
        response: undefined,
      });
      expect(mockSendStatusUpdateCalls[1]).toEqual({
        conversationId: "conv-1",
        status: { status: "PROCESSING", customMessage: "Running tool" },
        response: undefined,
      });
    });

    test("sends error response via sendAgentResponse on onError", async () => {
      const adapter = createMockAdapter({
        stream: async (_prompt, hooks) => {
          hooks.onError(new Error("something broke"));
        },
      });
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });

      await bridge.start();

      mockResponseHandlers[0]({
        conversationId: "conv-1",
        incomingMessage: {
          conversationId: "conv-1",
          content: "test",
          platform: "slack",
          user: { id: "user-1" },
        },
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(mockSendAgentResponseCalls).toHaveLength(1);
      expect(mockSendAgentResponseCalls[0]).toEqual({
        conversationId: "conv-1",
        error: { code: "AGENT_ERROR", message: "something broke" },
      });
    });

    test("catches rejected stream promise and sends error", async () => {
      const adapter = createMockAdapter({
        stream: async () => {
          throw new Error("stream exploded");
        },
      });
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });

      await bridge.start();

      mockResponseHandlers[0]({
        conversationId: "conv-1",
        incomingMessage: {
          conversationId: "conv-1",
          content: "test",
          platform: "slack",
          user: { id: "user-1" },
        },
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(mockSendAgentResponseCalls).toHaveLength(1);
      expect(mockSendAgentResponseCalls[0]).toEqual({
        conversationId: "conv-1",
        error: { code: "AGENT_ERROR", message: "stream exploded" },
      });
    });

    test("catches non-Error rejections and wraps them", async () => {
      const adapter = createMockAdapter({
        stream: async () => {
          throw "string error";
        },
      });
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });

      await bridge.start();

      mockResponseHandlers[0]({
        conversationId: "conv-1",
        incomingMessage: {
          conversationId: "conv-1",
          content: "test",
          platform: "slack",
          user: { id: "user-1" },
        },
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(mockSendAgentResponseCalls).toHaveLength(1);
      expect(mockSendAgentResponseCalls[0]).toEqual({
        conversationId: "conv-1",
        error: { code: "AGENT_ERROR", message: "string error" },
      });
    });

    test("passes correct prompt and options to adapter.stream", async () => {
      let capturedPrompt: string | null = null;
      let capturedOptions: StreamOptions | null = null;

      const adapter = createMockAdapter({
        stream: async (prompt, hooks, options) => {
          capturedPrompt = prompt;
          capturedOptions = options;
          hooks.onFinish();
        },
      });
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });

      await bridge.start();

      mockResponseHandlers[0]({
        conversationId: "conv-42",
        incomingMessage: {
          conversationId: "conv-42",
          content: "What is the weather?",
          platform: "discord",
          user: { id: "user-99", username: "Bob" },
        },
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(capturedPrompt!).toBe("What is the weather?");
      expect(capturedOptions!.conversationId).toBe("conv-42");
      expect(capturedOptions!.userId).toBe("user-99");
      expect(capturedOptions!.platformContext).toBeUndefined();
      // The bridge now threads a per-turn abort signal into stream options so a
      // "stop generating" can cancel the in-flight model call.
      expect(capturedOptions!.signal).toBeInstanceOf(AbortSignal);
      // render/elicit are wired on the text-message path.
      expect(typeof capturedOptions!.render).toBe("function");
      expect(typeof capturedOptions!.elicit).toBe("function");
    });

    test("forwards platformContext from incoming message to adapter.stream", async () => {
      let capturedOptions: StreamOptions | null = null;

      const adapter = createMockAdapter({
        stream: async (_prompt, hooks, options) => {
          capturedOptions = options;
          hooks.onFinish();
        },
      });
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });

      await bridge.start();

      mockResponseHandlers[0]({
        conversationId: "conv-77",
        incomingMessage: {
          conversationId: "conv-77",
          content: "hi",
          platform: "slack",
          user: { id: "U123", username: "Ada" },
          platformContext: {
            messageId: "1700000000.000100",
            channelId: "C42",
            threadId: "1699999999.000001",
            workspaceId: "T9",
            eventKind: "EVENT_KIND_APP_MENTION",
            botUserId: "UBOT",
            userId: "U123",
          },
        },
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(capturedOptions!.platformContext).toEqual({
        messageId: "1700000000.000100",
        channelId: "C42",
        threadId: "1699999999.000001",
        workspaceId: "T9",
        eventKind: "EVENT_KIND_APP_MENTION",
        botUserId: "UBOT",
        userId: "U123",
      });
    });

    test("platformContext is undefined when incoming message has none", async () => {
      let capturedOptions: StreamOptions | null = null;

      const adapter = createMockAdapter({
        stream: async (_prompt, hooks, options) => {
          capturedOptions = options;
          hooks.onFinish();
        },
      });
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });

      await bridge.start();

      mockResponseHandlers[0]({
        conversationId: "conv-78",
        incomingMessage: {
          conversationId: "conv-78",
          content: "hi",
          platform: "grpc",
          user: { id: "U1", username: "Ada" },
        },
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(capturedOptions!.platformContext).toBeUndefined();
    });

    test("defaults userId to 'anonymous' when user.id is missing", async () => {
      let capturedOptions: StreamOptions | null = null;

      const adapter = createMockAdapter({
        stream: async (_prompt, hooks, options) => {
          capturedOptions = options;
          hooks.onFinish();
        },
      });
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });

      await bridge.start();

      mockResponseHandlers[0]({
        conversationId: "conv-1",
        incomingMessage: {
          conversationId: "conv-1",
          content: "hello",
          platform: "slack",
          user: { id: undefined as any },
        },
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(capturedOptions!.userId).toBe("anonymous");
    });

    test("full streaming sequence: START, status, deltas, status, END", async () => {
      const adapter = createMockAdapter({
        stream: async (_prompt, hooks) => {
          hooks.onStatusUpdate({ status: "THINKING" });
          hooks.onChunk("Hello");
          hooks.onChunk(" there");
          hooks.onStatusUpdate({ status: "GENERATING" });
          hooks.onFinish();
        },
      });
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });

      await bridge.start();

      mockResponseHandlers[0]({
        conversationId: "conv-1",
        incomingMessage: {
          conversationId: "conv-1",
          content: "hi",
          platform: "slack",
          user: { id: "user-1" },
        },
      });

      await new Promise((r) => setTimeout(r, 10));

      // Content flows through sendContentChunk, status through sendStatusUpdate.
      expect(mockSendContentChunkCalls[0].chunk.type).toBe("START");
      expect(mockSendStatusUpdateCalls[0].status).toEqual({ status: "THINKING" });
      expect(mockSendContentChunkCalls[1].chunk).toEqual({ type: "DELTA", content: "Hello" });
      expect(mockSendContentChunkCalls[2].chunk).toEqual({ type: "DELTA", content: " there" });
      expect(mockSendStatusUpdateCalls[1].status).toEqual({ status: "GENERATING" });
      const lastChunk = mockSendContentChunkCalls[mockSendContentChunkCalls.length - 1];
      expect(lastChunk.chunk.type).toBe("END");
    });
  });

  describe("audio handling", () => {
    test("dispatches audioConfig directly to streamAudio with conversationId and userId", async () => {
      let capturedOptions: StreamOptions | null = null;
      const adapter = createMockAdapter({
        streamAudio: async (_audio, hooks, options) => {
          capturedOptions = options;
          hooks.onFinish();
        },
      });
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });

      await bridge.start();

      mockAudioConfigHandlers[0]({
        encoding: "MULAW",
        sampleRate: 8000,
        channels: 1,
        conversationId: "conv-audio",
        userId: "user-42",
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(capturedOptions).toEqual({
        conversationId: "conv-audio",
        userId: "user-42",
      });
    });

    test("defaults userId to anonymous when audioConfig omits it", async () => {
      let capturedOptions: StreamOptions | null = null;
      const adapter = createMockAdapter({
        streamAudio: async (_audio, hooks, options) => {
          capturedOptions = options;
          hooks.onFinish();
        },
      });
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });

      await bridge.start();

      mockAudioConfigHandlers[0]({
        encoding: "MULAW",
        sampleRate: 8000,
        channels: 1,
        conversationId: "conv-audio",
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(capturedOptions).toEqual({
        conversationId: "conv-audio",
        userId: "anonymous",
      });
    });

    test("ignores [audio] text messages when adapter supports audio", async () => {
      const streamFn = mock(async () => {});
      const adapter = createMockAdapter({
        stream: streamFn,
        streamAudio: async (_audio, hooks) => { hooks.onFinish(); },
      });
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });

      await bridge.start();

      mockResponseHandlers[0]({
        conversationId: "conv-1",
        incomingMessage: {
          conversationId: "conv-1",
          content: "[audio]",
          platform: "twilio",
          user: { id: "user-1" },
        },
      });

      await new Promise((r) => setTimeout(r, 10));

      // Should not call stream() — the [audio] message is ignored
      expect(streamFn).not.toHaveBeenCalled();
      // Should not send any content chunks
      expect(mockSendContentChunkCalls).toHaveLength(0);
    });

    test("replies with error when adapter does not support audio", async () => {
      const adapter = createMockAdapter();
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });

      await bridge.start();

      mockResponseHandlers[0]({
        conversationId: "conv-no-audio",
        incomingMessage: {
          conversationId: "conv-no-audio",
          content: "[audio]",
          platform: "twilio",
          user: { id: "user-1" },
        },
      });

      await new Promise((r) => setTimeout(r, 10));

      const deltas = mockSendContentChunkCalls.filter((c) => c.chunk.type === "DELTA");
      expect(deltas).toHaveLength(1);
      expect(deltas[0].chunk.content).toContain("don't support audio");
    });
  });

  describe("debug logging", () => {
    test("suppresses diagnostic logs when DEBUG is not set", async () => {
      const origEnv = process.env.DEBUG;
      delete process.env.DEBUG;

      try {
        const adapter = createMockAdapter({
          stream: async (_prompt, hooks) => {
            hooks.onFinish();
          },
        });
        const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });
        await bridge.start();

        mockResponseHandlers[0]({
          conversationId: "conv-1",
          incomingMessage: {
            conversationId: "conv-1",
            content: "hello",
            platform: "slack",
            user: { id: "user-1" },
          },
        });

        await new Promise((r) => setTimeout(r, 10));

        expect(mockLoggerDebugCalls).toHaveLength(0);
      } finally {
        if (origEnv !== undefined) process.env.DEBUG = origEnv;
      }
    });

    test("emits diagnostic logs when DEBUG is set", async () => {
      const origEnv = process.env.DEBUG;
      process.env.DEBUG = "1";

      try {
        const adapter = createMockAdapter({
          stream: async (_prompt, hooks) => {
            hooks.onFinish();
          },
        });
        const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });
        await bridge.start();

        mockResponseHandlers[0]({
          conversationId: "conv-1",
          incomingMessage: {
            conversationId: "conv-1",
            content: "hello",
            platform: "slack",
            user: { id: "user-1" },
          },
        });

        await new Promise((r) => setTimeout(r, 10));

        const bridgeLog = mockLoggerDebugCalls.find((msg) => msg.includes("[bridge]"));
        expect(bridgeLog).toBeDefined();
      } finally {
        if (origEnv !== undefined) {
          process.env.DEBUG = origEnv;
        } else {
          delete process.env.DEBUG;
        }
      }
    });
  });

  describe("stop", () => {
    test("ends the stream and closes the client", async () => {
      const adapter = createMockAdapter();
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });

      await bridge.start();
      bridge.stop();

      expect(mockStreamEndCalled).toBe(true);
      expect(mockCloseCalled).toBe(true);
    });

    test("is safe to call before start", () => {
      const adapter = createMockAdapter();
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });

      // Should not throw
      bridge.stop();

      expect(mockStreamEndCalled).toBe(false);
      expect(mockCloseCalled).toBe(false);
    });

    test("is safe to call twice", async () => {
      const adapter = createMockAdapter();
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });

      await bridge.start();
      bridge.stop();
      bridge.stop(); // second call should not throw

      expect(mockStreamEndCalled).toBe(true);
      expect(mockCloseCalled).toBe(true);
    });
  });

  describe("feedback handling", () => {
    // Helpers — drive the bridge's response listener with a synthetic
    // AgentResponse whose `feedback` field is populated. Mirrors how the
    // real gRPC stream delivers feedback events server → agent.
    function emitFeedback(fb: any) {
      mockResponseHandlers[0]({ conversationId: fb.conversationId, feedback: fb } as any);
    }

    test("thumbs_up reaction is mapped to kind=thumbs_up and surfaces user fields", async () => {
      let captured: any = null;
      const adapter = createMockAdapter({
        onFeedback: (event) => {
          captured = event;
        },
      });
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });
      await bridge.start();

      emitFeedback({
        conversationId: "conv-1",
        responseId: "msg-ts-1",
        user: { id: "U1", username: "alice" },
        reaction: { type: 1, added: true },
      });

      expect(captured).not.toBeNull();
      expect(captured.kind).toBe("thumbs_up");
      expect(captured.conversationId).toBe("conv-1");
      expect(captured.responseId).toBe("msg-ts-1");
      expect(captured.userId).toBe("U1");
      expect(captured.userName).toBe("alice");
    });

    test("thumbs_down reaction is mapped to kind=thumbs_down", async () => {
      let captured: any = null;
      const adapter = createMockAdapter({
        onFeedback: (event) => {
          captured = event;
        },
      });
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });
      await bridge.start();

      emitFeedback({
        conversationId: "conv-1",
        reaction: { type: 2, added: true },
      });

      expect(captured.kind).toBe("thumbs_down");
    });

    test("text feedback surfaces text and prompt", async () => {
      let captured: any = null;
      const adapter = createMockAdapter({
        onFeedback: (event) => {
          captured = event;
        },
      });
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });
      await bridge.start();

      emitFeedback({
        conversationId: "conv-1",
        text: { text: "this was wrong", prompt: "What did you think?" },
      });

      expect(captured.kind).toBe("text");
      expect(captured.text).toBe("this was wrong");
      expect(captured.prompt).toBe("What did you think?");
    });

    test("adapter without onFeedback is a silent no-op", async () => {
      // No onFeedback override — createMockAdapter omits the method
      // entirely, mirroring the hasattr-gated path in the Python bridge.
      const adapter = createMockAdapter();
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });
      await bridge.start();

      // Must not throw
      expect(() => {
        emitFeedback({
          conversationId: "conv-1",
          reaction: { type: 1, added: true },
        });
      }).not.toThrow();
    });

    test("sync onFeedback that throws is swallowed", async () => {
      const adapter = createMockAdapter({
        onFeedback: () => {
          throw new Error("sync kaboom");
        },
      });
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });
      await bridge.start();

      // Must not throw — the bridge logs and continues so a buggy callback
      // can't break the stream reader.
      expect(() => {
        emitFeedback({
          conversationId: "conv-1",
          reaction: { type: 1, added: true },
        });
      }).not.toThrow();
    });

    test("async onFeedback rejection is caught via .catch handler", async () => {
      let resolved = false;
      const adapter = createMockAdapter({
        onFeedback: async () => {
          throw new Error("async kaboom");
        },
      });
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });
      await bridge.start();

      emitFeedback({
        conversationId: "conv-1",
        reaction: { type: 1, added: true },
      });

      // Let the microtask queue drain so the rejection's .catch fires.
      await new Promise((r) => setTimeout(r, 0));
      resolved = true;
      // If the rejection had escaped Bun would have flagged an unhandled
      // promise rejection by now; reaching this point passes the test.
      expect(resolved).toBe(true);
    });
  });

  describe("stop-generation (abort)", () => {
    function emitFeedback(fb: any) {
      mockResponseHandlers[0]({ conversationId: fb.conversationId, feedback: fb } as any);
    }

    function sendMessage(conversationId: string) {
      mockResponseHandlers[0]({
        conversationId,
        incomingMessage: {
          conversationId,
          content: "hello",
          platform: "slack",
          user: { id: "user-1" },
        },
      });
    }

    // proto-loader may surface StreamControl.action=STOP as the enum name, its
    // numeric value, or a numeric string — the bridge must abort on all three.
    for (const action of ["STOP", 1, "1"] as const) {
      test(`StreamControl STOP (action=${JSON.stringify(action)}) aborts the in-flight model call`, async () => {
        let capturedSignal: AbortSignal | undefined;
        const adapter = createMockAdapter({
          stream: (_p, _hooks, opts) =>
            new Promise<void>((resolve) => {
              capturedSignal = opts?.signal;
              opts?.signal?.addEventListener("abort", () => resolve());
            }),
        });
        const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });
        await bridge.start();

        sendMessage("conv-1");
        await new Promise((r) => setTimeout(r, 10));
        expect(capturedSignal).toBeDefined();
        expect(capturedSignal!.aborted).toBe(false);

        emitFeedback({
          conversationId: "conv-1",
          streamControl: { action, reason: "user stopped generation" },
        });
        await new Promise((r) => setTimeout(r, 10));

        expect(capturedSignal!.aborted).toBe(true);
      });
    }

    test("a non-STOP stream control does not abort the model call", async () => {
      let capturedSignal: AbortSignal | undefined;
      const adapter = createMockAdapter({
        stream: (_p, _hooks, opts) =>
          new Promise<void>(() => {
            capturedSignal = opts?.signal;
          }),
      });
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });
      await bridge.start();

      sendMessage("conv-1");
      await new Promise((r) => setTimeout(r, 10));

      emitFeedback({
        conversationId: "conv-1",
        streamControl: { action: 0, reason: "" }, // UNSPECIFIED, not STOP
      });
      await new Promise((r) => setTimeout(r, 10));

      expect(capturedSignal!.aborted).toBe(false);
    });

    test("abort is swallowed by .catch and does not surface an agent error", async () => {
      const adapter = createMockAdapter({
        stream: (_p, _hooks, opts) =>
          new Promise<void>((_resolve, reject) => {
            // Model call throws when aborted (as a real SDK does). The bridge's
            // .catch must recognize the abort and end quietly.
            opts?.signal?.addEventListener("abort", () =>
              reject(new Error("model call aborted"))
            );
          }),
      });
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });
      await bridge.start();

      sendMessage("conv-1");
      await new Promise((r) => setTimeout(r, 10));

      emitFeedback({
        conversationId: "conv-1",
        streamControl: { action: "STOP", reason: "" },
      });
      await new Promise((r) => setTimeout(r, 10));

      expect(mockSendAgentResponseCalls).toHaveLength(0);
    });

    test("a new message supersedes and aborts the prior in-flight turn", async () => {
      const signals: AbortSignal[] = [];
      const adapter = createMockAdapter({
        stream: (_p, _hooks, opts) =>
          new Promise<void>((resolve) => {
            if (opts?.signal) signals.push(opts.signal);
            opts?.signal?.addEventListener("abort", () => resolve());
          }),
      });
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });
      await bridge.start();

      sendMessage("conv-1"); // turn A
      await new Promise((r) => setTimeout(r, 10));
      sendMessage("conv-1"); // turn B supersedes A
      await new Promise((r) => setTimeout(r, 10));

      expect(signals).toHaveLength(2);
      expect(signals[0].aborted).toBe(true); // prior turn aborted
      expect(signals[1].aborted).toBe(false); // new turn still active
    });

    test("a STOP settles a pending render() so the awaiter cannot hang", async () => {
      let caught: any = null;
      const adapter = createMockAdapter({
        stream: async (_p, _hooks, opts) => {
          try {
            await opts.render!({ message: "approve?", dataSchema: { type: "object" } });
          } catch (err) {
            caught = err;
          }
        },
      });
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });
      await bridge.start();

      sendMessage("conv-1");
      await new Promise((r) => setTimeout(r, 10));

      emitFeedback({
        conversationId: "conv-1",
        streamControl: { action: "STOP", reason: "" },
      });
      await new Promise((r) => setTimeout(r, 10));

      expect(caught).toBeInstanceOf(Error);
      expect(String(caught.message)).toContain("aborted");
    });

    test("a superseding message settles the prior turn's pending render()", async () => {
      let caught: any = null;
      let calls = 0;
      const adapter = createMockAdapter({
        stream: async (_p, _hooks, opts) => {
          calls += 1;
          if (calls === 1) {
            try {
              await opts.render!({ message: "approve?", dataSchema: { type: "object" } });
            } catch (err) {
              caught = err;
            }
          }
        },
      });
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });
      await bridge.start();

      sendMessage("conv-1"); // turn A blocks on render()
      await new Promise((r) => setTimeout(r, 10));
      sendMessage("conv-1"); // turn B supersedes A
      await new Promise((r) => setTimeout(r, 10));

      expect(caught).toBeInstanceOf(Error);
      expect(String(caught.message)).toContain("aborted");
    });
  });

  describe("renderable / elicitation", () => {
    // Drive the response listener with a synthetic incoming message so
    // adapter.stream() runs and can call options.render()/elicit().
    function incoming(conversationId: string) {
      mockResponseHandlers[0]({
        conversationId,
        incomingMessage: {
          conversationId,
          content: "hi",
          platform: "web",
          user: { id: "user-1", username: "Ada" },
        },
      });
    }
    // Deliver a RenderableResponse the way the gRPC stream does: server → agent
    // as an AgentResponse whose feedback carries renderableResponse.
    function emitRenderableResponse(conversationId: string, response: any) {
      mockResponseHandlers[0]({
        conversationId,
        feedback: { conversationId, renderableResponse: response },
      } as any);
    }
    function lastRenderable(): any {
      const sent = mockSendAgentResponseCalls.find((r) => (r as any).renderable);
      return sent ? (sent as any).renderable : undefined;
    }

    test("render() emits an AgentResponse.renderable with defaults filled", async () => {
      const adapter = createMockAdapter({
        stream: async (_p, _h, options) => {
          void options.render!({
            message: "Approve this write?",
            dataSchema: { type: "object", properties: { ok: { type: "boolean" } } },
            value: { ok: true },
            intent: "tool_permission",
          });
        },
      });
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });
      await bridge.start();

      incoming("conv-r1");
      await new Promise((r) => setTimeout(r, 10));

      const renderable = lastRenderable();
      expect(renderable).toBeDefined();
      expect(renderable.id).toBeTruthy();
      expect(renderable.kind).toBe("RENDER_KIND_FORM");
      expect(renderable.message).toBe("Approve this write?");
      expect(JSON.parse(renderable.dataSchemaJson).type).toBe("object");
      expect(JSON.parse(renderable.valueJson)).toEqual({ ok: true });
      expect(renderable.allowedActions).toEqual([
        "RENDERABLE_ACTION_SUBMIT",
        "RENDERABLE_ACTION_CANCEL",
      ]);
      expect(renderable.intent).toBe("tool_permission");

      // Settle so the awaiter doesn't dangle.
      emitRenderableResponse("conv-r1", {
        id: renderable.id,
        action: "RENDERABLE_ACTION_CANCEL",
      });
    });

    test("a matching response resolves the render() promise", async () => {
      let result: any = null;
      const adapter = createMockAdapter({
        stream: async (_p, _h, options) => {
          result = await options.render!({ message: "Pick one", dataSchema: { type: "object" } });
        },
      });
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });
      await bridge.start();

      incoming("conv-r2");
      await new Promise((r) => setTimeout(r, 10));

      emitRenderableResponse("conv-r2", {
        id: lastRenderable().id,
        action: "RENDERABLE_ACTION_SUBMIT",
        contentJson: '{"choice":"a"}',
      });
      await new Promise((r) => setTimeout(r, 10));

      expect(result).not.toBeNull();
      expect(result.action).toBe("RENDERABLE_ACTION_SUBMIT");
      expect(result.contentJson).toBe('{"choice":"a"}');
    });

    test("an UNSUPPORTED response rejects with UnsupportedRenderableError", async () => {
      let caught: any = null;
      const adapter = createMockAdapter({
        stream: async (_p, _h, options) => {
          try {
            await options.render!({ message: "strict", dataSchema: { type: "object" } });
          } catch (err) {
            caught = err;
          }
        },
      });
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });
      await bridge.start();

      incoming("conv-r3");
      await new Promise((r) => setTimeout(r, 10));

      const id = lastRenderable().id;
      emitRenderableResponse("conv-r3", { id, action: "RENDERABLE_ACTION_UNSUPPORTED" });
      await new Promise((r) => setTimeout(r, 10));

      expect(caught).toBeInstanceOf(UnsupportedRenderableError);
      expect(caught.renderableId).toBe(id);
    });

    test("elicit() defaults to the MCP submit/decline/cancel action set", async () => {
      const adapter = createMockAdapter({
        stream: async (_p, _h, options) => {
          void options.elicit!("Your name?", {
            type: "object",
            properties: { name: { type: "string" } },
          });
        },
      });
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });
      await bridge.start();

      incoming("conv-r4");
      await new Promise((r) => setTimeout(r, 10));

      const renderable = lastRenderable();
      expect(renderable.message).toBe("Your name?");
      expect(renderable.allowedActions).toEqual([
        "RENDERABLE_ACTION_SUBMIT",
        "RENDERABLE_ACTION_DECLINE",
        "RENDERABLE_ACTION_CANCEL",
      ]);

      emitRenderableResponse("conv-r4", {
        id: renderable.id,
        action: "RENDERABLE_ACTION_CANCEL",
      });
    });

    test("render() rejects when allowedActions offers no CANCEL or DECLINE escape", async () => {
      let caught: any = null;
      const adapter = createMockAdapter({
        stream: async (_p, _h, options) => {
          try {
            await options.render!({
              message: "no escape",
              dataSchema: { type: "object" },
              allowedActions: ["RENDERABLE_ACTION_SUBMIT"],
            });
          } catch (err) {
            caught = err;
          }
        },
      });
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });
      await bridge.start();

      incoming("conv-r6");
      await new Promise((r) => setTimeout(r, 10));

      expect(caught).toBeInstanceOf(Error);
      expect(String(caught.message)).toContain("CANCEL or DECLINE");
      // Nothing should reach the wire when the invariant fails.
      expect(mockSendAgentResponseCalls.find((r) => (r as any).renderable)).toBeUndefined();
    });

    test("a response with no live awaiter is handed to onResume", async () => {
      let resumed: any = null;
      const adapter = createMockAdapter({
        onResume: (conversationId, response) => {
          resumed = { conversationId, response };
        },
      });
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });
      await bridge.start();

      emitRenderableResponse("conv-r5", {
        id: "orphan-1",
        action: "RENDERABLE_ACTION_SUBMIT",
        contentJson: "{}",
      });

      expect(resumed).not.toBeNull();
      expect(resumed.conversationId).toBe("conv-r5");
      expect(resumed.response.id).toBe("orphan-1");
    });

    test("a numeric UNSUPPORTED action still rejects (enum normalization)", async () => {
      let caught: any = null;
      const adapter = createMockAdapter({
        stream: async (_p, _h, options) => {
          try {
            await options.render!({ message: "strict", dataSchema: { type: "object" } });
          } catch (err) {
            caught = err;
          }
        },
      });
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });
      await bridge.start();

      incoming("conv-r7");
      await new Promise((r) => setTimeout(r, 10));

      // action arrives as the numeric enum value (5), not the prefixed string.
      emitRenderableResponse("conv-r7", { id: lastRenderable().id, action: 5 });
      await new Promise((r) => setTimeout(r, 10));

      expect(caught).toBeInstanceOf(UnsupportedRenderableError);
    });

    test("a numeric SUBMIT resolves with the canonical string action", async () => {
      let result: any = null;
      const adapter = createMockAdapter({
        stream: async (_p, _h, options) => {
          result = await options.render!({ message: "q", dataSchema: { type: "object" } });
        },
      });
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });
      await bridge.start();

      incoming("conv-r8");
      await new Promise((r) => setTimeout(r, 10));

      emitRenderableResponse("conv-r8", {
        id: lastRenderable().id,
        action: 1, // numeric SUBMIT
        contentJson: "{}",
      });
      await new Promise((r) => setTimeout(r, 10));

      expect(result.action).toBe("RENDERABLE_ACTION_SUBMIT");
    });

    test("stop() settles a pending render() without emitting AGENT_ERROR", async () => {
      let caught: any = null;
      const adapter = createMockAdapter({
        stream: async (_p, _h, options) => {
          try {
            await options.render!({ message: "q", dataSchema: { type: "object" } });
          } catch (err) {
            caught = err;
          }
        },
      });
      const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });
      await bridge.start();

      incoming("conv-r9");
      await new Promise((r) => setTimeout(r, 10));

      bridge.stop();
      await new Promise((r) => setTimeout(r, 10));

      expect(caught).toBeInstanceOf(Error);
      // Shutdown aborts the turn, so the adapter unwinds quietly rather than
      // sending an error on a stream that is being closed.
      const errors = mockSendAgentResponseCalls.filter((r) => (r as any).error);
      expect(errors).toHaveLength(0);
    });
  });
});

describe("saveConversation", () => {
  beforeEach(resetMockState);

  async function runTurn(
    call: (options: StreamOptions) => void,
    user: { id: string } | undefined = { id: "user_from_turn" }
  ) {
    const adapter = createMockAdapter({
      stream: async (_p, hooks, options) => {
        call(options);
        hooks.onFinish();
      },
    });
    const bridge = new MessagingBridge(adapter, { serverAddress: "test:9090" });
    await bridge.start();
    mockResponseHandlers[0]({
      conversationId: "conv-1",
      incomingMessage: {
        conversationId: "conv-1",
        content: "save this",
        platform: "slack",
        user,
      },
    });
    await new Promise((r) => setTimeout(r, 10));
  }

  test("forwards the copy and returns the derived id", async () => {
    let returned: string | undefined;
    await runTurn((options) => {
      returned = options.saveConversation!({
        idempotencyKey: "slack:C1:111.0001",
        title: "Thread",
        sourceLabel: "#eng",
        sourceUrl: "https://slack/x",
        messages: [
          { role: "user", author: "Ada", content: "hello" },
          { role: "assistant", content: "hi" },
        ],
      });
    });

    expect(returned).toBe("derived-conversation-id");
    expect(mockSendSaveConversationCalls).toHaveLength(1);
    const sent = mockSendSaveConversationCalls[0];
    expect(sent.idempotencyKey).toBe("slack:C1:111.0001");
    expect(sent.sourceLabel).toBe("#eng");
    expect(sent.messages[0].author).toBe("Ada");
  });

  // The person who asked is the person who gets the copy, so an agent that omits
  // userId must not silently address it to nobody.
  test("defaults the owner to the sender of the message being handled", async () => {
    await runTurn((options) => {
      options.saveConversation!({ idempotencyKey: "k", messages: [] });
    });
    expect(mockSendSaveConversationCalls[0].userId).toBe("user_from_turn");
  });

  test("an explicit userId wins over the turn's sender", async () => {
    await runTurn((options) => {
      options.saveConversation!({
        userId: "user_explicit",
        idempotencyKey: "k",
        messages: [],
      });
    });
    expect(mockSendSaveConversationCalls[0].userId).toBe("user_explicit");
  });
});
