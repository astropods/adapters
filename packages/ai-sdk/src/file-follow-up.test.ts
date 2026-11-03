import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const responseHandlers: Array<(response: unknown) => void> = [];
const ended: string[] = [];

mock.module("@astropods/messaging", () => ({
  audioEncodingToFiletype: (encoding: string) => encoding.toLowerCase(),
  MessagingClient: class {
    async connect() {}
    async healthCheck() {
      return { status: "SERVING" };
    }
    createConversationStream() {
      return {
        sendAgentConfig() {},
        sendMessage() {},
        sendStatusUpdate() {},
        sendAgentResponse() {},
        sendContentChunk(conversationId: string, chunk: { type: string }) {
          if (chunk.type === "END") ended.push(conversationId);
        },
        on(event: string, handler: (response: unknown) => void) {
          if (event === "response") responseHandlers.push(handler);
        },
        end() {},
      };
    }
    close() {}
  },
}));

const { ToolLoopAgent, simulateReadableStream } = await import("ai");
const { MockLanguageModelV4 } = await import("ai/test");
const { MessagingBridge } = await import("@astropods/adapter-core");
const { AISDKAdapter } = await import("./adapter");
const { fileTools } = await import("./file-tools");

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

// End-to-end through the real bridge, adapter, and read_table tool; only the gRPC client is fake.
describe("a follow-up question about an earlier file", () => {
  let dir: string;
  let path: string;
  const previousDir = process.env.AGENT_FILES_DIR;
  const toolOutputs: unknown[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "file-follow-up-"));
    process.env.AGENT_FILES_DIR = dir;
    path = join(dir, "upload-1.blob");
    await writeFile(path, "region,amount\nEast,100\nWest,200\n");

    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        const last = prompt[prompt.length - 1];
        const chunks =
          last.role === "tool"
            ? (toolOutputs.push((last.content[0] as { output: unknown }).output),
              [
                { type: "text-start", id: "t" },
                { type: "text-delta", id: "t", delta: "done" },
                { type: "text-end", id: "t" },
                { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
              ])
            : [
                { type: "tool-call", toolCallId: `tc-${toolOutputs.length}`, toolName: "read_table", input: JSON.stringify({ path }) },
                { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
              ];
        return { stream: simulateReadableStream({ chunks }) } as any;
      },
    });
    const agent = new ToolLoopAgent({ model, tools: { ...fileTools() } });
    await new MessagingBridge(new AISDKAdapter(agent, { supportsFiles: true }), { serverAddress: "test:9090" }).start();
  });

  afterAll(async () => {
    process.env.AGENT_FILES_DIR = previousDir;
    await rm(dir, { recursive: true, force: true });
  });

  async function send(conversationId: string, attachments: unknown[] = []): Promise<unknown> {
    const before = toolOutputs.length;
    const done = ended.length;
    responseHandlers[0]({
      conversationId,
      incomingMessage: { conversationId, content: "total it by region", platform: "slack", user: { id: "U1" }, attachments },
    });
    for (let i = 0; i < 100 && ended.length === done; i++) await new Promise((r) => setTimeout(r, 10));
    expect(toolOutputs.length).toBe(before + 1);
    return toolOutputs[before];
  }

  test("reads the file again in a later message of the same thread, but not in another thread", async () => {
    const attached = await send("C1:1700000000.000100", [
      { type: "FILE", filename: "deals.csv", storageKey: "upload-1", mimeType: "text/csv" },
    ]);
    expect(JSON.stringify(attached)).toContain("East");

    const followUp = await send("C1:1700000000.000100");
    expect(JSON.stringify(followUp)).toContain("East");

    const otherThread = await send("C2:1700000000.000200");
    expect(JSON.stringify(otherThread)).toContain("created in this conversation");
  });
});
