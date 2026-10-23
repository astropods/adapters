import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "./logger.js";
import { applyActiveTraceContext, mergeRequestHeaders } from "./otel/propagate.js";
import { createTraceparent } from "./trace.js";

/**
 * The actor attributed to any AI Gateway request made while active.
 *
 * actorKey is Astro's stable identity key — the same raw value already
 * sent as the Langfuse trace's `userId` (see the Mastra adapter's
 * `stream()`). astro-server classifies its kind server-side from this same
 * shape (billed-vs-estimated-cost-spec.md, Fifth revision note), so there
 * is nothing else to carry here.
 */
export interface ActorContext {
  actorKey: string;
  /**
   * The trace this turn belongs to, for a framework that keeps its own tracing
   * instead of the OTel globals. `withActorHeaders` prefers these over
   * `propagation.inject`, which has nothing to read in that case.
   *
   * Mastra is the reason this exists: its spans live in
   * `@mastra/observability`, so an agent turn has no OTel-active span. The
   * adapter mints a pair, hands it to Mastra as `tracingOptions.traceId` /
   * `parentSpanId`, and passes the same pair here, which puts the agent's
   * trace and the gateway call on one trace id.
   */
  traceId?: string;
  spanId?: string;
}

/** Fallback actorKey/userId when a request carries no identity. */
export const ANONYMOUS_ACTOR_KEY = "anonymous";

const storage = new AsyncLocalStorage<ActorContext>();

/**
 * Runs `fn` with `actor` as the active actor context. Any gateway request
 * a `fetch` wrapped by `withActorHeaders` makes during `fn` — including
 * from nested async work `fn` kicks off — carries `actor`'s key.
 */
export function withActorContext<T>(actor: ActorContext, fn: () => T): T {
  return storage.run(actor, fn);
}

/** The actor context `withActorContext` set for the currently running async
 *  call, or undefined outside one. */
export function activeActor(): ActorContext | undefined {
  return storage.getStore();
}

type FetchInput = string | URL | Request;
type FetchCall = (input: FetchInput, init?: RequestInit) => Promise<Response>;

/**
 * Wraps `fetch` (default: `globalThis.fetch`) so a call made inside
 * `withActorContext` carries `x-bf-dim-actor_key` — the header bifrost-otel
 * decodes to attribute billed AI Gateway cost to an actor
 * (billed-vs-estimated-cost-spec.md, "Telling gateway traffic apart, and
 * merging it"). Outside any `withActorContext` call, or with an empty
 * actorKey, the request carries no actor.
 *
 * It also carries the active W3C trace context, so the gateway call joins the
 * agent's own trace and `bifrost-otel`'s billed record shares its trace id.
 * That part does not depend on an actor being active, but it does depend on a
 * globally registered tracer provider — see `applyActiveTraceContext`.
 *
 * Pass the result as the `fetch` option to an AI SDK provider factory —
 * e.g. `createOpenAI({ fetch: withActorHeaders() })` — so every request
 * that provider issues picks up the active actor.
 */
export function withActorHeaders(
  baseFetch: FetchCall = globalThis.fetch as FetchCall,
): FetchCall {
  return async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    const actor = activeActor();
    const headers = mergeRequestHeaders(input, init);

    // Trace context goes out whether or not an actor is active. An
    // unattributed gateway call still belongs to the agent's trace, and
    // bifrost-otel keys its billed record by the call's own trace and span
    // ids, so dropping the context here is what stops a trace page joining a
    // billed figure to its estimated one.
    //
    // Ids carried on the context win over the OTel globals: a framework that
    // supplies them does so precisely because it does not put its spans there,
    // so injecting would otherwise write nothing.
    const traced = applyTraceContext(headers, actor);

    if (!actor?.actorKey) {
      // Nothing was added, so hand the call through exactly as it arrived
      // rather than replacing the caller's headers with an equivalent copy.
      return traced ? baseFetch(input, { ...init, headers }) : baseFetch(input, init);
    }

    // actorKey rides in untouched from the caller (ultimately options.userId),
    // so a value Headers rejects as an invalid header value (e.g. a stray
    // CR/LF) must not fail the gateway call over a best-effort attribution tag.
    try {
      headers.set("x-bf-dim-actor_key", actor.actorKey);
    } catch (err) {
      logger.warn({ err }, "[withActorHeaders] actorKey is not a valid header value, sending request unattributed");
    }

    return baseFetch(input, { ...init, headers });
  };
}

/**
 * Adds trace context to `headers` from the actor context's own ids when it
 * carries them, otherwise from the OTel globals. Returns whether anything was
 * added. A `traceparent` the caller set explicitly is left alone either way.
 */
function applyTraceContext(headers: Headers, actor: ActorContext | undefined): boolean {
  if (actor?.traceId && actor.spanId) {
    if (headers.has("traceparent")) return false;
    const traceparent = createTraceparent({ traceId: actor.traceId, spanId: actor.spanId });
    // Empty when either id is malformed; a wrong traceparent would join a
    // billed figure to the wrong trace, which is worse than sending none.
    if (!traceparent) return false;
    headers.set("traceparent", traceparent);
    return true;
  }
  return applyActiveTraceContext(headers);
}
