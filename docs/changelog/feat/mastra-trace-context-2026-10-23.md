# Trace context on Mastra's gateway calls

## Summary

`withActorHeaders` carries W3C trace context by reading the OTel globals, which
works for the AI SDK adapter because its provider registers there. Mastra keeps
its spans in `@mastra/observability` instead, so a Mastra agent's turn has no
OTel-active span and `propagation.inject` writes nothing.

That left Mastra-built agents sending gateway requests on a trace of their own,
with no way for a trace page to join a billed figure to its estimated one.
Per-actor spend on Insights was never affected, being keyed by day, deployment,
model and actor rather than by trace.

## Design

The adapter mints a W3C-shaped trace and span id per turn (`newTraceIds`) and
hands the same pair to two places: Mastra, as `tracingOptions.traceId` and
`parentSpanId`, and the actor context, which `withActorHeaders` reads when
building the request's headers.

```ts
const traceIds = newTraceIds();
return withActorContext({ actorKey: traceUserId, ...traceIds }, () => …);
```

`ActorContext` gained optional `traceId`/`spanId`, and ids carried there win
over the OTel globals. A framework that supplies them does so precisely because
it does not put its spans in the global context, so injecting would write
nothing; preferring the explicit pair also keeps the two ends from disagreeing.
A malformed pair is dropped rather than sent, since a syntactically valid
`traceparent` naming the wrong trace would join a billed figure to the wrong
trace — worse than sending none.

Minting rather than reading back matters for ordering. Mastra reports its trace
id on the stream object, which only exists once `agent.stream()` has returned,
by which point the gateway call it describes may already be in flight. Supplying
the id inverts that: Mastra joins the trace we name instead of naming one we
then have to catch up with. `tracingOptions.parentSpanId` is documented for
exactly this, "correlating with an external tracing system (e.g. an
OpenTelemetry span in the calling service)".

`streamAudio` gets a pair too. Its STT and TTS legs do not go through
`agent.stream()`, so there is no `tracingOptions` to hand it to, but they still
carry it on their own gateway requests; the text leg between them picks up its
own through `stream()`.

## Migration

None. Existing deployments pick this up on their next build.
