import { describe, test, expect } from "bun:test";
import { createAgent } from "langchain";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import type { BaseMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import type { StreamHooks, StreamOptions } from "@astropods/adapter-core";

import { LangChainAdapter } from "./adapter";
import type { LangChainAgent } from "./adapter";

const hooks: StreamHooks = {
  onChunk() {},
  onStatusUpdate() {},
  onError(error) {
    throw error;
  },
  onFinish() {},
  onTranscript() {},
  onAudioChunk() {},
  onAudioEnd() {},
  onFile() {},
};

const options: StreamOptions = { conversationId: "conv-1", userId: "user-1" };

const edit: NonNullable<StreamOptions["history"]> = {
  messages: [
    { id: "h1", role: "user", content: "q1" },
    { id: "h2", role: "assistant", content: "a1" },
  ],
  isComplete: true,
};

function agentWithMemory() {
  const checkpointer = new MemorySaver();
  const agent = createAgent({
    model: new FakeListChatModel({ responses: ["ok"] }),
    tools: [],
    checkpointer,
  });
  return { agent: agent as unknown as LangChainAgent, checkpointer };
}

async function threadTexts(checkpointer: MemorySaver): Promise<string[]> {
  const tuple = await checkpointer.getTuple({ configurable: { thread_id: "conv-1" } });
  const messages = (tuple?.checkpoint.channel_values.messages ?? []) as Array<{ content: unknown }>;
  return messages.map((m) => String(m.content));
}

async function seed(adapter: LangChainAdapter) {
  await adapter.stream("q1", hooks, options);
  await adapter.stream("q2", hooks, options);
}

describe("LangChainAdapter conversation history", () => {
  test("an edit replaces the checkpointer thread with the given history", async () => {
    const { agent, checkpointer } = agentWithMemory();
    const adapter = new LangChainAdapter(agent);
    await seed(adapter);

    await adapter.stream("q2 edited", hooks, { ...options, history: edit });

    expect(await threadTexts(checkpointer)).toEqual(["q1", "a1", "q2 edited", "ok"]);
  });

  test("an empty history starts the thread over", async () => {
    const { agent, checkpointer } = agentWithMemory();
    const adapter = new LangChainAdapter(agent);
    await seed(adapter);

    await adapter.stream("q1 edited", hooks, {
      ...options,
      history: { messages: [], isComplete: true },
    });

    expect(await threadTexts(checkpointer)).toEqual(["q1 edited", "ok"]);
  });

  test("a send without history keeps the thread", async () => {
    const { agent, checkpointer } = agentWithMemory();
    const adapter = new LangChainAdapter(agent);
    await seed(adapter);

    await adapter.stream("q3", hooks, options);

    expect(await threadTexts(checkpointer)).toEqual(["q1", "ok", "q2", "ok", "q3", "ok"]);
  });

  test("supportsHistory: false leaves the thread alone", async () => {
    const { agent, checkpointer } = agentWithMemory();
    const adapter = new LangChainAdapter(agent, { supportsHistory: false });
    await seed(adapter);

    await adapter.stream("q2 edited", hooks, { ...options, history: edit });

    expect(await threadTexts(checkpointer)).toEqual(["q1", "ok", "q2", "ok", "q2 edited", "ok"]);
  });

  test("supportsHistory: true on a checkpointer that cannot delete keeps the thread and skips the history", async () => {
    const checkpointer = new MemorySaver();
    Object.defineProperty(checkpointer, "deleteThread", { value: undefined });
    const agent = createAgent({
      model: new FakeListChatModel({ responses: ["ok"] }),
      tools: [],
      checkpointer,
    }) as unknown as LangChainAgent;
    const adapter = new LangChainAdapter(agent, { supportsHistory: true });

    await seed(adapter);
    await adapter.stream("q2 edited", hooks, { ...options, history: edit });

    expect(
      await threadTexts(checkpointer),
      "history prepended onto a thread that was not deleted would duplicate q1 and a1",
    ).toEqual(["q1", "ok", "q2", "ok", "q2 edited", "ok"]);
  });

  test("declares history support by default, and not when opted out", () => {
    const { agent } = agentWithMemory();
    expect(new LangChainAdapter(agent).getConfig().supportsHistory).toBe(true);
    expect(
      new LangChainAdapter(agent, { supportsHistory: false }).getConfig().supportsHistory
    ).toBe(false);
  });
});

function quietHooks(): StreamHooks & { errors: Error[] } {
  const errors: Error[] = [];
  return {
    errors,
    onChunk() {},
    onStatusUpdate() {},
    onError(error) {
      errors.push(error);
    },
    onFinish() {},
    onTranscript() {},
    onAudioChunk() {},
    onAudioEnd() {},
    onFile() {},
  };
}

class GatedModel extends FakeListChatModel {
  private gate: Promise<void>;
  release!: () => void;

  constructor(private readonly slowPrompt: string) {
    super({ responses: ["ok"] });
    this.gate = new Promise((resolve) => (this.release = resolve));
  }

  // FakeListChatModel.bindTools returns a fresh FakeListChatModel, which would drop the gate.
  bindTools(): any {
    return this;
  }

  private async wait(messages: BaseMessage[]) {
    if (String(messages.at(-1)?.content) === this.slowPrompt) await this.gate;
  }

  async _generate(messages: BaseMessage[], options?: any, runManager?: any) {
    await this.wait(messages);
    return super._generate(messages, options, runManager);
  }

  async *_streamResponseChunks(messages: BaseMessage[], options: any, runManager?: any) {
    await this.wait(messages);
    yield* super._streamResponseChunks(messages, options, runManager);
  }
}

describe("LangChainAdapter history reset under a superseded turn", () => {
  test("a stopped turn that is still running does not overwrite the edited thread", async () => {
    const checkpointer = new MemorySaver();
    const model = new GatedModel("q2");
    const agent = createAgent({ model, tools: [], checkpointer }) as unknown as LangChainAgent;
    const adapter = new LangChainAdapter(agent);

    await adapter.stream("q1", quietHooks(), options);

    const stop = new AbortController();
    const superseded = adapter.stream("q2", quietHooks(), { ...options, signal: stop.signal });
    await new Promise((r) => setTimeout(r, 20));
    stop.abort();

    await adapter.stream("q2 edited", quietHooks(), {
      ...options,
      history: {
        messages: [
          { id: "m1", role: "user", content: "q1" },
          { id: "m2", role: "assistant", content: "ok" },
        ],
        isComplete: true,
      },
    });
    expect(await threadTexts(checkpointer)).toEqual(["q1", "ok", "q2 edited", "ok"]);

    model.release();
    await superseded;
    await new Promise((r) => setTimeout(r, 20));

    expect(
      await threadTexts(checkpointer),
      "the stopped q2 turn must not write the discarded branch back over the edited one"
    ).toEqual(["q1", "ok", "q2 edited", "ok"]);
  });
});

describe("LangChainAdapter history support", () => {
  const agentWith = (checkpointer: unknown) =>
    ({ checkpointer, stream: async () => (async function* () {})() }) as unknown as LangChainAgent;

  test("is declared when the checkpointer can delete a thread, or there is none", () => {
    expect(new LangChainAdapter(agentWith(new MemorySaver())).getConfig().supportsHistory).toBe(true);
    expect(new LangChainAdapter(agentWith(undefined)).getConfig().supportsHistory).toBe(true);
    expect(new LangChainAdapter(agentWith(false)).getConfig().supportsHistory).toBe(true);
  });

  test("is not declared when the checkpointer cannot delete a thread", () => {
    const keepsThreads = { getTuple: async () => undefined };
    expect(new LangChainAdapter(agentWith(keepsThreads)).getConfig().supportsHistory).toBe(false);
    expect(new LangChainAdapter(agentWith(true)).getConfig().supportsHistory).toBe(false);
  });

  test("an explicit option wins", () => {
    expect(
      new LangChainAdapter(agentWith({}), { supportsHistory: true }).getConfig().supportsHistory
    ).toBe(true);
    expect(
      new LangChainAdapter(agentWith(new MemorySaver()), { supportsHistory: false }).getConfig().supportsHistory
    ).toBe(false);
  });
});
