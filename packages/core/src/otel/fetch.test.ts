import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";

import { patchGlobalFetch } from "./fetch";

let originalFetch: typeof fetch;
let exporter: InMemorySpanExporter;
let provider: NodeTracerProvider;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  exporter = new InMemorySpanExporter();
  provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  trace.disable();
  await provider.shutdown();
});

function stubFetch(response: Response | Error): typeof fetch {
  return ((_input: RequestInfo | URL, _init?: RequestInit) => {
    if (response instanceof Error) {
      return Promise.reject(response);
    }
    return Promise.resolve(response);
  }) as typeof fetch;
}

describe("patchGlobalFetch", () => {
  test("emits a CLIENT span with HTTP semconv attributes for a successful request", async () => {
    globalThis.fetch = stubFetch(new Response("ok", { status: 200 }));
    patchGlobalFetch();

    await fetch("https://api.example.com/widgets?id=1");

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.kind).toBe(2); // SpanKind.CLIENT
    expect(span.name).toBe("GET");
    expect(span.attributes["http.request.method"]).toBe("GET");
    expect(span.attributes["url.full"]).toBe(
      "https://api.example.com/widgets?id=1",
    );
    expect(span.attributes["server.address"]).toBe("api.example.com");
    expect(span.attributes["server.port"]).toBe(443);
    expect(span.attributes["http.response.status_code"]).toBe(200);
  });

  test("captures method from init for POST", async () => {
    globalThis.fetch = stubFetch(new Response(null, { status: 201 }));
    patchGlobalFetch();

    await fetch("https://api.example.com/widgets", { method: "post" });

    const span = exporter.getFinishedSpans()[0]!;
    expect(span.attributes["http.request.method"]).toBe("POST");
    expect(span.attributes["http.response.status_code"]).toBe(201);
  });

  test("captures method from a Request object when no init is provided", async () => {
    globalThis.fetch = stubFetch(new Response(null, { status: 204 }));
    patchGlobalFetch();

    await fetch(new Request("https://api.example.com/x", { method: "DELETE" }));

    const span = exporter.getFinishedSpans()[0]!;
    expect(span.attributes["http.request.method"]).toBe("DELETE");
  });

  test("marks 5xx responses as ERROR but resolves normally", async () => {
    globalThis.fetch = stubFetch(new Response(null, { status: 503 }));
    patchGlobalFetch();

    const res = await fetch("https://api.example.com/down");
    expect(res.status).toBe(503);

    const span = exporter.getFinishedSpans()[0]!;
    expect(span.attributes["http.response.status_code"]).toBe(503);
    expect(span.status.code).toBe(2); // SpanStatusCode.ERROR
  });

  test("records network failures and re-throws", async () => {
    const boom = new TypeError("network unreachable");
    globalThis.fetch = stubFetch(boom);
    patchGlobalFetch();

    await expect(fetch("https://api.example.com/x")).rejects.toThrow(
      "network unreachable",
    );

    const span = exporter.getFinishedSpans()[0]!;
    expect(span.status.code).toBe(2);
    expect(span.attributes["error.type"]).toBe("TypeError");
    // recordException stores under "exception" events
    expect(span.events.some((e) => e.name === "exception")).toBe(true);
  });

  test("is idempotent across repeated calls", async () => {
    globalThis.fetch = stubFetch(new Response("ok"));
    patchGlobalFetch();
    const afterFirst = globalThis.fetch;
    patchGlobalFetch();
    patchGlobalFetch();
    expect(globalThis.fetch).toBe(afterFirst);

    await fetch("https://api.example.com/x");
    expect(exporter.getFinishedSpans()).toHaveLength(1);
  });

  test("skips spans for the configured OTLP endpoint's own export POSTs", async () => {
    const originalEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://otel-collector:4318";

    try {
      globalThis.fetch = stubFetch(new Response(null, { status: 200 }));
      patchGlobalFetch();

      await fetch("http://otel-collector:4318/v1/traces", { method: "POST" });
      await fetch("http://otel-collector:4318/v1/metrics", { method: "POST" });
      await fetch("http://otel-collector:4318/v1/logs", { method: "POST" });
      // Same host but a path outside the OTLP signal list — user traffic,
      // should still get a span.
      await fetch("http://otel-collector:4318/healthz");

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0]!.attributes["url.full"]).toBe(
        "http://otel-collector:4318/healthz",
      );
    } finally {
      if (originalEndpoint === undefined) {
        delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      } else {
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalEndpoint;
      }
    }
  });

  test("preserves own properties on the original fetch (e.g. Bun's preconnect)", () => {
    const original = stubFetch(new Response("ok")) as typeof fetch & {
      preconnect?: (url: string) => void;
      arbitraryProp?: string;
    };
    original.preconnect = () => {};
    original.arbitraryProp = "from-runtime";
    globalThis.fetch = original;

    patchGlobalFetch();

    const wrapped = globalThis.fetch as typeof fetch & {
      preconnect?: unknown;
      arbitraryProp?: unknown;
    };
    expect(wrapped).not.toBe(original);
    expect(wrapped.preconnect).toBe(original.preconnect);
    expect(wrapped.arbitraryProp).toBe("from-runtime");
  });
});
