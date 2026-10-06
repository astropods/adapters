# Trace AI SDK 7 agents, and make agent errors traceable to a conversation

## Summary

Three gaps made a broken agent hard to diagnose:

- **AI SDK 7 agents sent no spans.** `astroTelemetry()` returned `{ isEnabled: true, tracer }`. AI SDK 6 reads `tracer`, but AI SDK 7 ignores it and sends spans only to registered telemetry integrations. An AI SDK 7 agent therefore had an empty trace view. On preview, an AI SDK agent's two turns produced 0 traces, while Mastra, Claude Agent SDK and LangChain agents produced 2 each.
- **"Agent error" lines named no conversation.** The TypeScript bridge logged the error alone, and the Python bridge logged only `str(error)` with no traceback. Neither could be matched to the user report that prompted the search.
- **A stop could log as an error.** The bridge ignores an abort when the adapter's promise rejects. An adapter that catches the abort itself and calls `hooks.onError` still produced an "Agent error" line and an `AGENT_ERROR` response.

## Design

`astroTelemetry()` keeps `tracer` for AI SDK 6 and adds an `@ai-sdk/otel` `OpenTelemetry` integration built on the same tracer for AI SDK 7:

```ts
return { isEnabled: true, tracer, integrations: [new OpenTelemetry({ tracer })] };
```

The spans follow the GenAI semantic conventions (`invoke_agent`, `chat`), which Langfuse already shows for the other adapters. `@ai-sdk/otel` pins `ai` to its own release, so the package's dev dependency moves to `ai` 7.0.128 to keep one copy. Consumers see only the `TelemetryOptions` return type, so their own `ai` version is unaffected. `telemetry.test.ts` runs a `ToolLoopAgent` turn with the helper's settings and checks that the tracer starts spans. The test fails with the old `{ isEnabled, tracer }` settings. A generated AI SDK agent, run against a fake gateway with this build, exported `invoke_agent`, `chat` and `gen_ai` spans to an OTLP receiver. With the published 0.4.3 it exported none.

`buildHooks` takes the turn's abort signal. `onError` from a stopped turn now logs at debug and sends nothing, because the sidecar already finalizes a stopped turn. The error line now carries `conversationId`. The Python `on_error` logs `conversation=<id>` and the traceback through `exc_info`.

## Migration

None. AI SDK 7 agents that already use `astroTelemetry()` start sending spans after upgrading `@astropods/adapter-ai-sdk`.
