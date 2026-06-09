import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { FakeCollector } from "./fixtures/fake-collector";
import { TargetServer } from "./fixtures/target-server";
import { runScenario, type Runtime } from "./fixtures/child-runner";

const RUNTIMES: Runtime[] = ["bun", "node"];

let collector: FakeCollector;
let collectorUrl: string;
let target: TargetServer;
let targetUrl: string;

beforeAll(() => {
  collector = new FakeCollector();
  target = new TargetServer();
  collectorUrl = collector.start().url;
  targetUrl = target.start().url;
});

afterAll(() => {
  collector.stop();
  target.stop();
});

beforeEach(() => {
  collector.reset();
});

function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    OTEL_EXPORTER_OTLP_ENDPOINT: collectorUrl,
    TARGET_URL: targetUrl,
    ASTRO_AGENT_NAME: "integration-test",
    ASTRO_AGENT_BUILD: "0.0.0-test",
    ...extra,
  };
}

for (const runtime of RUNTIMES) {
  describe(`integration under ${runtime}`, () => {
    test("side-effect import wraps fetch and exports a CLIENT span end-to-end", async () => {
      const { exitCode, result, stderr } = await runScenario("basic-fetch.mjs", {
        runtime,
        env: baseEnv(),
      });

      expect(exitCode, `stderr:\n${stderr}`).toBe(0);
      expect(result).toMatchObject({ ok: true, status: 200, requested: 200 });

      const spans = collector.spans();
      expect(spans).toHaveLength(1);
      const span = spans[0]!;
      expect(span.name).toBe("GET");
      expect(span.kind).toBe(3); // CLIENT
      expect(span.attributes["http.request.method"]).toBe("GET");
      expect(span.attributes["url.full"]).toBe(`${targetUrl}/status/200`);
      expect(span.attributes["server.address"]).toBe("127.0.0.1");
      expect(span.attributes["http.response.status_code"]).toBe(200);
      expect(span.resourceAttributes["service.name"]).toBe("integration-test");
    });

    test("explicit instrumentHttp() form behaves identically to the side-effect import", async () => {
      const { exitCode, result, stderr } = await runScenario("explicit-call.mjs", {
        runtime,
        env: baseEnv(),
      });

      expect(exitCode, `stderr:\n${stderr}`).toBe(0);
      expect(result).toMatchObject({ ok: true, status: 200 });

      const spans = collector.spans();
      expect(spans).toHaveLength(1);
      expect(spans[0]!.attributes["http.request.method"]).toBe("GET");
    });

    test("no-op when OTEL_EXPORTER_OTLP_ENDPOINT is unset", async () => {
      const env = baseEnv();
      // Override: explicit empty string drops it from the child process.
      delete (env as Record<string, string | undefined>).OTEL_EXPORTER_OTLP_ENDPOINT;
      const { exitCode, result, stderr } = await runScenario("no-endpoint.mjs", {
        runtime,
        env: env as Record<string, string>,
      });

      expect(exitCode, `stderr:\n${stderr}`).toBe(0);
      expect(result).toMatchObject({
        ok: true,
        status: 200,
        fetchUnchanged: true,
      });
      expect(collector.spans()).toHaveLength(0);
    });

    test("each HTTP method and status code is captured correctly", async () => {
      const { exitCode, result, stderr } = await runScenario("methods-and-status.mjs", {
        runtime,
        env: baseEnv(),
      });

      expect(exitCode, `stderr:\n${stderr}`).toBe(0);
      expect(result).toMatchObject({ ok: true, count: 6 });

      const spans = collector.spans();
      expect(spans).toHaveLength(6);

      const byUrl = new Map(spans.map((s) => [String(s.attributes["url.full"]), s]));

      const get200 = byUrl.get(`${targetUrl}/status/200`)!;
      expect(get200.attributes["http.request.method"]).toBe("GET");
      expect(get200.attributes["http.response.status_code"]).toBe(200);
      expect(get200.status?.code ?? 0).toBe(0); // OK / unset

      const post = byUrl.get(`${targetUrl}/echo`)!;
      // Two echo calls (POST + PUT) — at least one should be a POST.
      const echoMethods = spans
        .filter((s) => s.attributes["url.full"] === `${targetUrl}/echo`)
        .map((s) => s.attributes["http.request.method"]);
      expect(echoMethods).toContain("POST");
      expect(echoMethods).toContain("PUT");
      expect(post.attributes["http.response.status_code"]).toBe(200);

      const get404 = byUrl.get(`${targetUrl}/status/404`)!;
      expect(get404.attributes["http.response.status_code"]).toBe(404);
      expect(get404.status?.code ?? 0).toBe(2); // ERROR

      const get503 = byUrl.get(`${targetUrl}/status/503`)!;
      expect(get503.attributes["http.response.status_code"]).toBe(503);
      expect(get503.status?.code ?? 0).toBe(2); // ERROR
    });

    test("connection failures produce an error span and re-throw", async () => {
      const { exitCode, result, stderr } = await runScenario("network-failure.mjs", {
        runtime,
        env: baseEnv(),
      });

      expect(exitCode, `stderr:\n${stderr}`).toBe(0);
      expect(result.ok).toBe(true);
      expect(result.threw).toBe(true);

      const spans = collector.spans();
      expect(spans).toHaveLength(1);
      const span = spans[0]!;
      expect(span.status?.code).toBe(2); // ERROR
      expect(typeof span.attributes["error.type"]).toBe("string");
      expect(span.events.some((e) => e.name === "exception")).toBe(true);
    });

    test("repeated side-effect + explicit instrumentation produces exactly one span per fetch", async () => {
      const { exitCode, result, stderr } = await runScenario("idempotency.mjs", {
        runtime,
        env: baseEnv(),
      });

      expect(exitCode, `stderr:\n${stderr}`).toBe(0);
      expect(result.ok).toBe(true);
      expect(collector.spans()).toHaveLength(1);
    });

    test("injects W3C trace context into outgoing headers and preserves user headers", async () => {
      const { exitCode, result, stderr } = await runScenario("propagation.mjs", {
        runtime,
        env: baseEnv(),
      });

      expect(exitCode, `stderr:\n${stderr}`).toBe(0);
      expect(result.ok).toBe(true);
      expect(result.userHeader).toBe("preserved");
      expect(result.traceparent).toMatch(
        /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/,
      );

      const spans = collector.spans();
      expect(spans).toHaveLength(1);
      // The traceparent the server saw must reference our emitted span.
      const [, traceId, spanId] = String(result.traceparent).split("-");
      expect(spans[0]!.traceId).toBe(traceId);
      expect(spans[0]!.spanId).toBe(spanId);
    });

    test("five concurrent fetches yield five distinct spans with the right query strings", async () => {
      const { exitCode, result, stderr } = await runScenario("concurrent.mjs", {
        runtime,
        env: baseEnv(),
      });

      expect(exitCode, `stderr:\n${stderr}`).toBe(0);
      expect(result).toMatchObject({ ok: true, count: 5 });

      const spans = collector.spans();
      expect(spans).toHaveLength(5);

      const ids = spans
        .map((s) => new URL(String(s.attributes["url.full"])).searchParams.get("id"))
        .filter((v): v is string => v !== null)
        .sort();
      expect(ids).toEqual(["1", "2", "3", "4", "5"]);

      // Each span should be independent — distinct span IDs.
      const spanIds = new Set(spans.map((s) => s.spanId));
      expect(spanIds.size).toBe(5);
    });
  });
}
