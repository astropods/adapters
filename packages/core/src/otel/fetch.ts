import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  type Tracer,
} from "@opentelemetry/api";
import {
  ATTR_ERROR_TYPE,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
  ATTR_URL_FULL,
} from "@opentelemetry/semantic-conventions";

const PATCHED_MARKER = Symbol.for("@astropods/adapter-core/patched-fetch");
const TRACER_NAME = "@astropods/adapter-core/fetch";

type FetchInput = string | URL | Request;
type FetchCall = (input: FetchInput, init?: RequestInit) => Promise<Response>;

interface PatchedFn {
  [PATCHED_MARKER]?: true;
}

/**
 * Replaces `globalThis.fetch` with a wrapper that emits an OpenTelemetry
 * CLIENT span per call and injects W3C trace context headers into the
 * outgoing request. Idempotent. Requests to the configured OTLP endpoint
 * are passed through unwrapped to prevent recursion through the exporter.
 */
export function patchGlobalFetch(): void {
  const current = globalThis.fetch as (FetchCall & PatchedFn) | undefined;
  if (!current) return;
  if (current[PATCHED_MARKER]) return;

  const original = current.bind(globalThis) as FetchCall;
  const tracer: Tracer = trace.getTracer(TRACER_NAME);
  const otlpHosts = collectOtlpHosts();

  const wrapped: FetchCall & PatchedFn = async function tracedFetch(
    input: FetchInput,
    init?: RequestInit,
  ): Promise<Response> {
    const urlString = extractUrl(input);
    if (isOtlpExportRequest(urlString, otlpHosts)) {
      return original(input, init);
    }
    const method = extractMethod(input, init);
    const parsed = safeParseUrl(urlString);

    const attributes: Record<string, string | number> = {
      [ATTR_HTTP_REQUEST_METHOD]: method,
      [ATTR_URL_FULL]: urlString,
    };
    if (parsed) {
      attributes[ATTR_SERVER_ADDRESS] = parsed.hostname;
      const port = derivePort(parsed);
      if (port !== undefined) {
        attributes[ATTR_SERVER_PORT] = port;
      }
    }

    return tracer.startActiveSpan(
      method,
      { kind: SpanKind.CLIENT, attributes },
      async (span) => {
        const initWithContext = injectTraceContext(input, init);
        try {
          const response = await original(input, initWithContext);
          span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, response.status);
          if (response.status >= 400) {
            span.setStatus({ code: SpanStatusCode.ERROR });
          }
          return response;
        } catch (err) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: err instanceof Error ? err.message : String(err),
          });
          span.setAttribute(
            ATTR_ERROR_TYPE,
            err instanceof Error ? err.name : "Error",
          );
          if (err instanceof Error) {
            span.recordException(err);
          }
          throw err;
        } finally {
          span.end();
        }
      },
    );
  };

  // Preserve own properties on the original (e.g. Bun's `fetch.preconnect`).
  for (const key of Reflect.ownKeys(current)) {
    if (key === "length" || key === "name" || key === "prototype") continue;
    if (Object.prototype.hasOwnProperty.call(wrapped, key)) continue;
    const desc = Object.getOwnPropertyDescriptor(current, key);
    if (desc) Object.defineProperty(wrapped, key, desc);
  }

  Object.defineProperty(wrapped, PATCHED_MARKER, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  globalThis.fetch = wrapped as unknown as typeof globalThis.fetch;
}

/**
 * Returns a `RequestInit` whose `headers` carry the active W3C trace
 * context. Existing headers on the input Request and the user's `init`
 * are preserved; explicit traceparent/tracestate set by the caller wins.
 */
function injectTraceContext(
  input: FetchInput,
  init: RequestInit | undefined,
): RequestInit {
  const merged = new Headers();
  if (typeof input === "object" && !(input instanceof URL)) {
    input.headers.forEach((value, key) => merged.set(key, value));
  }
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => merged.set(key, value));
  }

  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  for (const [key, value] of Object.entries(carrier)) {
    if (!merged.has(key)) merged.set(key, value);
  }

  return { ...init, headers: merged };
}

function extractUrl(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function extractMethod(input: FetchInput, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof input === "object" && !(input instanceof URL)) {
    return (input.method ?? "GET").toUpperCase();
  }
  return "GET";
}

function safeParseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

const OTLP_SIGNAL_PATHS = new Set([
  "/v1/traces",
  "/v1/metrics",
  "/v1/logs",
]);

function isOtlpExportRequest(urlString: string, otlpHosts: Set<string>): boolean {
  if (otlpHosts.size === 0) return false;
  const parsed = safeParseUrl(urlString);
  if (!parsed) return false;
  if (!otlpHosts.has(parsed.host)) return false;
  return OTLP_SIGNAL_PATHS.has(parsed.pathname);
}

function collectOtlpHosts(): Set<string> {
  const hosts = new Set<string>();
  const envVars = [
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
    "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  ];
  for (const name of envVars) {
    const value = process.env[name];
    if (!value) continue;
    const parsed = safeParseUrl(value);
    if (parsed) hosts.add(parsed.host);
  }
  return hosts;
}

function derivePort(url: URL): number | undefined {
  if (url.port) return Number(url.port);
  if (url.protocol === "https:") return 443;
  if (url.protocol === "http:") return 80;
  return undefined;
}
