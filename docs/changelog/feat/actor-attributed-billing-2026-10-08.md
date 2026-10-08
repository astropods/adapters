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
`injectTraceContext` already does for trace context (input's own headers
first, then init's, matching how the Fetch API itself resolves a `Request`
passed alongside an `init`) — a second, small instance of that shape rather
than a shared helper, since the two call sites have nothing else in common.

## Migration

Existing deployments pick this up on their next build; no action required.
Installing an agent framework scaffold that doesn't yet wire
`withActorHeaders()` into its gateway client (Claude Agent SDK, LangChain)
still works exactly as before — its spend is still billed, just not yet
attributed to an actor.
