import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";

import { activeActor, withActorContext, withActorHeaders } from "./actor-context";

describe("withActorContext / activeActor", () => {
  test("is undefined outside any withActorContext call", () => {
    expect(activeActor()).toBeUndefined();
  });

  test("is visible inside the callback, and through nested async work", async () => {
    await withActorContext({ actorKey: "user_123" }, async () => {
      expect(activeActor()).toEqual({ actorKey: "user_123" });
      await Promise.resolve();
      expect(activeActor()).toEqual({ actorKey: "user_123" });
    });
  });

  test("does not leak into a call made after it returns", async () => {
    await withActorContext({ actorKey: "user_123" }, async () => {});
    expect(activeActor()).toBeUndefined();
  });

  test("concurrent calls each see only their own actor", async () => {
    const seenA: (string | undefined)[] = [];
    const seenB: (string | undefined)[] = [];
    await Promise.all([
      withActorContext({ actorKey: "user_a" }, async () => {
        seenA.push(activeActor()?.actorKey);
        await new Promise((r) => setTimeout(r, 5));
        seenA.push(activeActor()?.actorKey);
      }),
      withActorContext({ actorKey: "user_b" }, async () => {
        seenB.push(activeActor()?.actorKey);
        await new Promise((r) => setTimeout(r, 1));
        seenB.push(activeActor()?.actorKey);
      }),
    ]);
    expect(seenA).toEqual(["user_a", "user_a"]);
    expect(seenB).toEqual(["user_b", "user_b"]);
  });
});

describe("withActorHeaders", () => {
  function stubFetch(): { fetch: typeof fetch; calls: [RequestInfo | URL, RequestInit | undefined][] } {
    const calls: [RequestInfo | URL, RequestInit | undefined][] = [];
    const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      return new Response("ok");
    }) as typeof fetch;
    return { fetch: fetchStub, calls };
  }

  test("passes a call outside any actor context through unchanged", async () => {
    const { fetch: base, calls } = stubFetch();
    const wrapped = withActorHeaders(base);

    await wrapped("https://gateway.example/v1/chat/completions", { method: "POST" });

    expect(calls).toHaveLength(1);
    const [, init] = calls[0];
    expect(init?.headers).toBeUndefined();
  });

  test("adds x-bf-dim-actor_key for a call made inside withActorContext", async () => {
    const { fetch: base, calls } = stubFetch();
    const wrapped = withActorHeaders(base);

    await withActorContext({ actorKey: "user_123" }, () =>
      wrapped("https://gateway.example/v1/chat/completions", { method: "POST" }),
    );

    expect(calls).toHaveLength(1);
    const [, init] = calls[0];
    expect(new Headers(init?.headers).get("x-bf-dim-actor_key")).toBe("user_123");
  });

  test("preserves the caller's own headers alongside the new one", async () => {
    const { fetch: base, calls } = stubFetch();
    const wrapped = withActorHeaders(base);

    await withActorContext({ actorKey: "user_123" }, () =>
      wrapped("https://gateway.example/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer sk-test" },
      }),
    );

    const [, init] = calls[0];
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-test");
    expect(headers.get("x-bf-dim-actor_key")).toBe("user_123");
  });

  test("a Request input's own headers survive, with init and the actor header layered on top", async () => {
    const { fetch: base, calls } = stubFetch();
    const wrapped = withActorHeaders(base);
    const request = new Request("https://gateway.example/v1/chat/completions", {
      method: "POST",
      headers: { "x-from-request": "1" },
    });

    await withActorContext({ actorKey: "user_123" }, () => wrapped(request));

    const [, init] = calls[0];
    const headers = new Headers(init?.headers);
    expect(headers.get("x-from-request")).toBe("1");
    expect(headers.get("x-bf-dim-actor_key")).toBe("user_123");
  });

  test("an empty actorKey is treated as no actor", async () => {
    const { fetch: base, calls } = stubFetch();
    const wrapped = withActorHeaders(base);

    await withActorContext({ actorKey: "" }, () => wrapped("https://gateway.example/v1/chat/completions"));

    const [, init] = calls[0];
    expect(init?.headers).toBeUndefined();
  });

  test("a header-illegal actorKey does not fail the call, just goes unattributed", async () => {
    const { fetch: base, calls } = stubFetch();
    const wrapped = withActorHeaders(base);

    await withActorContext({ actorKey: "bad\r\nkey" }, () =>
      wrapped("https://gateway.example/v1/chat/completions", { headers: { "x-from-init": "1" } }),
    );

    expect(calls).toHaveLength(1);
    const [, init] = calls[0];
    const headers = new Headers(init?.headers);
    expect(headers.has("x-bf-dim-actor_key")).toBe(false);
    // Headers that had already been merged before the invalid set survive.
    expect(headers.get("x-from-init")).toBe("1");
  });

  test("defaults to globalThis.fetch when no base fetch is given", () => {
    // Just needs to construct without throwing; behavior is covered above
    // via the stubbed-base tests.
    expect(() => withActorHeaders()).not.toThrow();
  });

  // Pins today's answer to open question 2 of
  // docs/01-spec/billed-vs-estimated-cost-spec.md (astropods/astro): a gateway
  // request carries the actor but no W3C trace context, so bifrost-otel's
  // billed record cannot share the agent's trace id and a trace page cannot
  // join the two. Insights is unaffected, being keyed by day, deployment,
  // model and actor rather than by trace. When trace-context injection moves
  // into withActorHeaders, invert the traceparent assertion here.
  describe("W3C trace context", () => {
    let provider: NodeTracerProvider;

    beforeEach(() => {
      provider = new NodeTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())],
      });
      provider.register();
    });

    afterEach(async () => {
      trace.disable();
      await provider.shutdown();
    });

    test("sends no traceparent, even from inside a recording span", async () => {
      const { fetch: base, calls } = stubFetch();
      const wrapped = withActorHeaders(base);

      await trace.getTracer("actor-context-test").startActiveSpan("agent turn", async (span) => {
        // Without a real recording span there would be nothing for any
        // propagator to inject, and the assertion below would pass for the
        // wrong reason.
        expect(span.isRecording()).toBe(true);
        expect(span.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);

        await withActorContext({ actorKey: "user_123" }, () =>
          wrapped("https://gateway.example/v1/chat/completions", { method: "POST" }),
        );
        span.end();
      });

      expect(calls).toHaveLength(1);
      const [, init] = calls[0];
      const headers = new Headers(init?.headers);
      expect(headers.get("x-bf-dim-actor_key")).toBe("user_123");
      expect(headers.get("traceparent")).toBeNull();
    });
  });
});
