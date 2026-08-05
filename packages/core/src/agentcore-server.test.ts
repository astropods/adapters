import { describe, test, expect, afterEach } from "bun:test";
import type { AgentAdapter, StreamHooks, StreamOptions } from "./types";
import type { AgentConfig } from "@astropods/messaging";
import { AgentCoreServer } from "./agentcore-server";

// A minimal echo-then-joke adapter, mirroring hello-astro's shape.
function echoAdapter(overrides: Partial<AgentAdapter> = {}): AgentAdapter {
  return {
    name: "Test Agent",
    async stream(prompt: string, hooks: StreamHooks, _options: StreamOptions) {
      hooks.onChunk(`Echo: ${prompt}`);
      hooks.onChunk("Here's a joke: knock knock");
      hooks.onFinish();
    },
    getConfig(): AgentConfig {
      return { systemPrompt: "test", tools: [] } as unknown as AgentConfig;
    },
    ...overrides,
  };
}

let server: AgentCoreServer | null = null;
// Each test uses a distinct port to avoid bind races.
let nextPort = 18080;

async function startOn(adapter: AgentAdapter): Promise<number> {
  const port = nextPort++;
  process.env.PORT = String(port);
  server = new AgentCoreServer(adapter);
  await server.start();
  return port;
}

// Parse an SSE body into the list of JSON event objects.
function parseSse(body: string): Array<Record<string, unknown>> {
  return body
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice("data: ".length)));
}

afterEach(() => {
  server?.stop();
  server = null;
  delete process.env.PORT;
});

describe("AgentCoreServer", () => {
  test("GET /ping returns Healthy", async () => {
    const port = await startOn(echoAdapter());
    const res = await fetch(`http://127.0.0.1:${port}/ping`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "Healthy" });
  });

  test("POST /invocations drives adapter.stream and emits START/DELTA/END SSE", async () => {
    const port = await startOn(echoAdapter());
    const res = await fetch(`http://127.0.0.1:${port}/invocations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hello there", sessionId: "conv-1" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const events = parseSse(await res.text());
    expect(events[0]).toEqual({ type: "START" });
    expect(events).toContainEqual({ type: "DELTA", content: "Echo: hello there" });
    expect(events).toContainEqual({ type: "DELTA", content: "Here's a joke: knock knock" });
    expect(events.at(-1)).toEqual({ type: "END" });
  });

  test("adapter error surfaces as an ERROR event", async () => {
    const port = await startOn(
      echoAdapter({
        async stream(_p, hooks) {
          hooks.onError(new Error("boom"));
        },
      })
    );
    const res = await fetch(`http://127.0.0.1:${port}/invocations`, {
      method: "POST",
      body: JSON.stringify({ prompt: "x" }),
    });
    const events = parseSse(await res.text());
    expect(events).toContainEqual({ type: "ERROR", code: "AGENT_ERROR", message: "boom" });
  });

  test("resume invoke routes to onResume, not stream", async () => {
    let streamCalls = 0;
    let resumed: { conversationId: string; id: string } | null = null;
    const port = await startOn(
      echoAdapter({
        async stream(_p, hooks) {
          streamCalls++;
          hooks.onFinish();
        },
        onResume(conversationId, response) {
          resumed = { conversationId, id: response.id };
        },
      })
    );
    const res = await fetch(`http://127.0.0.1:${port}/invocations`, {
      method: "POST",
      body: JSON.stringify({
        sessionId: "conv-9",
        resume: { renderableId: "rid-1", action: "RENDERABLE_ACTION_SUBMIT", valueJson: "{}" },
      }),
    });
    const events = parseSse(await res.text());
    expect(events.at(-1)).toEqual({ type: "END" });
    expect(streamCalls).toBe(0);
    expect(resumed).toEqual({ conversationId: "conv-9", id: "rid-1" });
  });

  test("elicit() emits an ELICIT event and ends the turn", async () => {
    const port = await startOn(
      echoAdapter({
        async stream(_p, hooks, options) {
          // The elicit promise settles on a later resume invoke (or rejects at
          // server stop). Swallow here so teardown's rejection isn't unhandled.
          options.elicit?.("Need your name", { type: "object" }).catch(() => {});
          // Give the microtask queue a tick so the ELICIT event is written.
          await new Promise((r) => setTimeout(r, 20));
        },
      })
    );
    const res = await fetch(`http://127.0.0.1:${port}/invocations`, {
      method: "POST",
      body: JSON.stringify({ prompt: "hi", sessionId: "conv-e" }),
    });
    const events = parseSse(await res.text());
    const elicit = events.find((e) => e.type === "ELICIT");
    expect(elicit).toBeDefined();
    expect(elicit?.message).toBe("Need your name");
    expect(elicit?.allowedActions).toEqual([
      "RENDERABLE_ACTION_SUBMIT",
      "RENDERABLE_ACTION_CANCEL",
    ]);
  });

  test("unknown route returns 404", async () => {
    const port = await startOn(echoAdapter());
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(res.status).toBe(404);
  });
});
