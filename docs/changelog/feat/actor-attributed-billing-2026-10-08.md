# Tag AI Gateway requests with the active actor

## Summary

The AI Gateway could tell which deployment a request belonged to, but not which
person inside the account made it. Astro's Insights pages priced that spend by
estimating it from Langfuse instead of reading the invoice, because there was
no exact, per-person figure to read. Closing that gap (`astro`'s
`docs/01-spec/billed-vs-estimated-cost-spec.md`) needs every gateway request a
deployed agent makes to carry the acting person's identity, not just the
deployment's.

## Design

`@astropods/adapter-core` adds `withActorContext`/`activeActor`, an
`AsyncLocalStorage`-backed pair, and `withActorHeaders`, a `fetch` wrapper that
adds `x-bf-dim-actor_key` to a request when an actor is active:

```ts
const gateway = createOpenAI({ fetch: withActorHeaders() });

return withActorContext({ actorKey: options.userId || "anonymous" }, () =>
  runTurn(),
);
```

Both the Mastra and AI SDK adapters wrap the whole turn this way: the initial
model call, every step a multi-step tool loop takes, and every
tool-approval/suspension resume. Each of those is its own model call and each
needs the same attribution as the first, so the wrap has to cover the turn as
a unit, not just its first request. `actorKey` is the same raw value already
sent as the Langfuse trace's `userId` — astro-server classifies its kind
server-side from that same shape, so the agent never needs to send one.

`withActorHeaders` merges headers the same way `otel/fetch.ts`'s
`injectTraceContext` already does for trace context: input's own headers
first, then init's, with init winning on a conflict. This is a deliberate
departure from the Fetch API's own `Request` constructor, which replaces
input's headers outright when `init.headers` is present rather than merging
them — a second, small instance of the merge shape rather than a shared
helper, since the two call sites have nothing else in common.

### What the wrapper does not send

`withActorHeaders` adds the actor and nothing else. In particular it sends no
W3C trace context, so the gateway request starts a trace the agent's own span
is not part of. The only thing in this package that injects `traceparent` is
`patchGlobalFetch`, behind the opt-in `@astropods/adapter-core/instrument`
entry point, which the scaffold templates do not import.

A test pins that, asserting the absence from inside a recording span so it
cannot pass for want of one. It matters downstream: astro's `bifrost-otel`
records a billed figure per gateway call keyed by the call's own trace and
span ids, and without shared trace context a trace page cannot join its
estimated figure to the billed one. Per-actor spend on Insights is unaffected,
being keyed by day, deployment, model and actor rather than by trace.

If that join is wanted, the fix belongs here rather than in the opt-in entry
point: this wrapper already builds the header set and this package already
depends on `@opentelemetry/api`, so attribution and trace linking would travel
together instead of depending on an import a user can drop.

## Migration

Existing deployments pick this up on their next build; no action required.
Installing an agent framework scaffold that doesn't yet wire
`withActorHeaders()` into its gateway client (Claude Agent SDK, LangChain)
still works exactly as before — its spend is still billed, just not yet
attributed to an actor.

## Follow-up fix

An independent review caught the Design section's own claim above (and a
matching comment in `actor-context.ts`) getting the native Fetch API's
behavior backwards — now corrected. The merge behavior itself was already
correct; only the claim about what native `fetch` does was wrong.

## Follow-up fixes from a later review pass

- `MastraAdapter.streamAudio()` generated its text response inside
  `withActorContext` (through its own call to `stream()`), but ran its STT
  and TTS legs outside it — the only method whose turn is three gateway
  calls instead of one, with the middle one attributed and the other two
  not. Now wraps the whole method, mirroring `stream()`'s own wrap.
- `withActorHeaders` called `Headers.set` with the active actor's key
  unvalidated. A key containing a stray CR/LF — a malformed `userId`, not
  anything this wrapper controls — throws there, failing the whole gateway
  call over what is meant to be a best-effort attribution tag. Now caught;
  the request still goes out, just unattributed.
