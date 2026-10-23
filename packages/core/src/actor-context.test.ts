import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";

import { activeActor, withActorContext, withActorHeaders } from "./actor-context";
import { newTraceIds } from "./trace";

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

  // Open question 2 of docs/01-spec/billed-vs-estimated-cost-spec.md
  // (astropods/astro): bifrost-otel keys its billed record by the gateway
  // call's own trace and span ids, so a trace page can only join a billed
  // figure to its estimated one if the request carries the agent's trace
  // context. Insights never depended on this, being keyed by day, deployment,
  // model and actor rather than by trace.
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

    test("sends the active span's trace id, not merely a well-formed traceparent", async () => {
      const { fetch: base, calls } = stubFetch();
      const wrapped = withActorHeaders(base);
      let expectedTraceId = "";
      let expectedSpanId = "";

      await trace.getTracer("actor-context-test").startActiveSpan("agent turn", async (span) => {
        // Without a real recording span there is nothing for the propagator to
        // inject, and the assertions below would pass for the wrong reason.
        expect(span.isRecording()).toBe(true);
        expectedTraceId = span.spanContext().traceId;
        expectedSpanId = span.spanContext().spanId;
        expect(expectedTraceId).toMatch(/^[0-9a-f]{32}$/);

        await withActorContext({ actorKey: "user_123" }, () =>
          wrapped("https://gateway.example/v1/chat/completions", { method: "POST" }),
        );
        span.end();
      });

      expect(calls).toHaveLength(1);
      const [, init] = calls[0];
      const headers = new Headers(init?.headers);
      expect(headers.get("x-bf-dim-actor_key")).toBe("user_123");
      // The trace id is the point. A syntactically valid traceparent carrying
      // some other trace would join a billed figure to the wrong trace, which
      // is worse than showing none.
      expect(headers.get("traceparent")).toBe(`00-${expectedTraceId}-${expectedSpanId}-01`);
    });

    test("sends trace context for a call with no actor at all", async () => {
      const { fetch: base, calls } = stubFetch();
      const wrapped = withActorHeaders(base);
      let expectedTraceId = "";

      await trace.getTracer("actor-context-test").startActiveSpan("agent turn", async (span) => {
        expectedTraceId = span.spanContext().traceId;
        // No withActorContext wrapper: an unattributed gateway call still
        // belongs to the agent's trace.
        await wrapped("https://gateway.example/v1/chat/completions", { method: "POST" });
        span.end();
      });

      const [, init] = calls[0];
      const headers = new Headers(init?.headers);
      expect(headers.has("x-bf-dim-actor_key")).toBe(false);
      expect(headers.get("traceparent")).toContain(expectedTraceId);
    });

    test("leaves a traceparent the caller set explicitly alone", async () => {
      const { fetch: base, calls } = stubFetch();
      const wrapped = withActorHeaders(base);
      const caller = "00-11111111111111111111111111111111-2222222222222222-01";

      await trace.getTracer("actor-context-test").startActiveSpan("agent turn", async (span) => {
        await withActorContext({ actorKey: "user_123" }, () =>
          wrapped("https://gateway.example/v1/chat/completions", {
            method: "POST",
            headers: { traceparent: caller },
          }),
        );
        span.end();
      });

      const [, init] = calls[0];
      expect(new Headers(init?.headers).get("traceparent")).toBe(caller);
    });

    test("prefers ids carried on the actor context over the OTel globals", async () => {
      const { fetch: base, calls } = stubFetch();
      const wrapped = withActorHeaders(base);
      const ids = newTraceIds();

      // A registered provider with an active span, so the globals have
      // something to offer and losing to the context is a real preference
      // rather than a fallback.
      await trace.getTracer("actor-context-test").startActiveSpan("agent turn", async (span) => {
        expect(span.spanContext().traceId).not.toBe(ids.traceId);
        await withActorContext({ actorKey: "user_123", ...ids }, () =>
          wrapped("https://gateway.example/v1/chat/completions", { method: "POST" }),
        );
        span.end();
      });

      const [, init] = calls[0];
      expect(new Headers(init?.headers).get("traceparent")).toBe(
        `00-${ids.traceId}-${ids.spanId}-01`,
      );
    });

    test("ignores a malformed id pair rather than sending a wrong trace", async () => {
      const { fetch: base, calls } = stubFetch();
      const wrapped = withActorHeaders(base);

      await withActorContext({ actorKey: "user_123", traceId: "nope", spanId: "nope" }, () =>
        wrapped("https://gateway.example/v1/chat/completions", { method: "POST" }),
      );

      const headers = new Headers(calls[0][1]?.headers);
      expect(headers.get("x-bf-dim-actor_key")).toBe("user_123");
      expect(headers.get("traceparent")).toBeNull();
    });

    test("passes a call through untouched when no provider is registered", async () => {
      // The production shape before this change, and still the shape for any
      // runtime that does not register globally: nothing to inject, no actor,
      // so the caller's init must not be replaced by an equivalent copy.
      trace.disable();
      const { fetch: base, calls } = stubFetch();
      const wrapped = withActorHeaders(base);

      await wrapped("https://gateway.example/v1/chat/completions", { method: "POST" });

      const [, init] = calls[0];
      expect(init?.headers).toBeUndefined();
    });
  });
});
