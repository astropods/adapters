import { context, propagation } from "@opentelemetry/api";

/**
 * Header plumbing shared by the two `fetch` wrappers that both need to merge
 * a caller's headers and then add their own: `patchGlobalFetch` (the opt-in
 * `/instrument` entry point) and `withActorHeaders` (the gateway attribution
 * wrapper on the main entry point).
 *
 * Imports only `@opentelemetry/api`, never the SDK, so the main entry point
 * does not pull a tracer provider in behind it.
 */

export type FetchInput = string | URL | Request;

/**
 * The caller's headers as one `Headers`: `input`'s own first (when `input` is
 * a `Request`), then `init`'s, with `init` winning on a conflict.
 *
 * The Fetch API's own `Request` constructor does not merge the two this way —
 * `init.headers`, when present, replaces `input`'s outright — so a wrapper
 * that adds a header has to do the merge itself or silently drop whichever
 * set it did not read.
 */
export function mergeRequestHeaders(input: FetchInput, init?: RequestInit): Headers {
  const merged = new Headers();
  if (typeof input === "object" && !(input instanceof URL)) {
    input.headers.forEach((value, key) => merged.set(key, value));
  }
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => merged.set(key, value));
  }
  return merged;
}

/**
 * Adds the active W3C trace context to `headers`, leaving any `traceparent`
 * or `tracestate` the caller set explicitly alone.
 *
 * A no-op unless a propagator and a context manager are registered globally
 * and a span is active: `propagation.inject` writes nothing without them.
 * That is why `getOrCreateAstroTracerProvider` registers by default — an
 * unregistered provider still exports spans, but leaves this silently empty.
 *
 * Returns whether anything was added, so a caller can tell an injected
 * request apart from an untouched one without diffing headers.
 */
export function applyActiveTraceContext(headers: Headers): boolean {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  let added = false;
  for (const [key, value] of Object.entries(carrier)) {
    if (!headers.has(key)) {
      headers.set(key, value);
      added = true;
    }
  }
  return added;
}
