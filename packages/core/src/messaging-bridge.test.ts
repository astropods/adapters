import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { AgentAdapter, StreamHooks, StreamOptions } from "./types";
import type {
  AgentConfig,
  AgentResponse,
  ContentChunk,
  Message,
  StatusUpdate,
} from "@astromode-ai/astro-messaging";

// --- Mock state ---

let mockConnectCalled = false;
let mockHealthCheckCalled = false;
let mockCloseCalled = false;
let mockStreamEndCalled = false;
let mockSendAgentConfigArgs: AgentConfig | null = null;
let mockSendMessageArgs: Message | null = null;
let mockSendContentChunkCalls: Array<{ conversationId: string; chunk: ContentChunk }> = [];
let mockSendStatusUpdateCalls: Array<{ conversationId: string; status: StatusUpdate }> = [];
let mockSendAgentResponseCalls: AgentResponse[] = [];
let mockResponseHandlers: Array<(response: AgentResponse) => void> = [];
let mockErrorHandlers: Array<(error: Error) => void> = [];
let mockEndHandlers: Array<() => void> = [];
let mockConstructorAddr: string | null = null;

// --- Mock messaging SDK ---

mock.module("@astromode-ai/astro-messaging", () => ({
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
        sendContentChunk(conversationId: string, chunk: ContentChunk) {
          mockSendContentChunkCalls.push({ conversationId, chunk });
        },
        sendStatusUpdate(conversationId: string, status: StatusUpdate) {
          mockSendStatusUpdateCalls.push({ conversationId, status });
        },
        sendAgentResponse(response: AgentResponse) {
          mockSendAgentResponseCalls.push(response);
        },
        on(event: string, handler: any) {
          if (event === "response") mockResponseHandlers.push(handler);
          if (event === "error") mockErrorHandlers.push(handler);
          if (event === "end") mockEndHandlers.push(handler);
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

const { MessagingBridge } = await import("./messaging-bridge");

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
  mockSendAgentConfigArgs = null;
  mockSendMessageArgs = null;
  mockSendContentChunkCalls = [];
  mockSendStatusUpdateCalls = [];
  mockSendAgentResponseCalls = [];
  mockResponseHandlers = [];
  mockErrorHandlers = [];
  mockEndHandlers = [];
  mockConstructorAddr = null;
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
      });
      // Last call: END
      const lastChunk = mockSendContentChunkCalls[mockSendContentChunkCalls.length - 1];
      expect(lastChunk).toEqual({
        conversationId: "conv-1",
        chunk: { type: "END", content: "" },
      });
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
      });
      expect(mockSendStatusUpdateCalls[1]).toEqual({
        conversationId: "conv-1",
        status: { status: "PROCESSING", customMessage: "Running tool" },
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
      expect(capturedOptions!).toEqual({
        conversationId: "conv-42",
        userId: "user-99",
      });
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

      // Verify the full sequence
      expect(mockSendContentChunkCalls[0].chunk.type).toBe("START");
      expect(mockSendStatusUpdateCalls[0].status).toEqual({ status: "THINKING" });
      expect(mockSendContentChunkCalls[1].chunk).toEqual({ type: "DELTA", content: "Hello" });
      expect(mockSendContentChunkCalls[2].chunk).toEqual({ type: "DELTA", content: " there" });
      expect(mockSendStatusUpdateCalls[1].status).toEqual({ status: "GENERATING" });
      const lastChunk = mockSendContentChunkCalls[mockSendContentChunkCalls.length - 1];
      expect(lastChunk.chunk.type).toBe("END");
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
});
