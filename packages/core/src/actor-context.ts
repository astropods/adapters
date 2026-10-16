import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "./logger.js";

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
 * actorKey, requests pass through unchanged.
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
    if (!actor?.actorKey) return baseFetch(input, init);

    // input's own headers first (when input is a Request), then init's,
    // with init winning on a conflict. The Fetch API's own Request
    // constructor does not merge the two this way: init.headers, when
    // present, replaces input's headers outright.
    const headers = new Headers();
    if (typeof input === "object" && !(input instanceof URL)) {
      input.headers.forEach((value, key) => headers.set(key, value));
    }
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
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
