# @astropods/adapter-ai-sdk

Vercel AI SDK adapter for the Astro messaging service. Wraps a `ToolLoopAgent` (the v6 `Experimental_Agent` class) and connects it to the Astro runtime, with automatic OpenTelemetry tracing when deployed.

## Installation

```bash
bun add @astropods/adapter-ai-sdk
```

Requires `ai >= 6.0.0`.

## Usage

```typescript
import { Experimental_Agent as Agent } from "ai";
import { openai } from "@ai-sdk/openai";
import { serve } from "@astropods/adapter-ai-sdk";

const instructions = "You are a helpful assistant.";

const agent = new Agent({
  model: openai("gpt-4o"),
  instructions,
  experimental_telemetry: { isEnabled: true },
});

serve(agent, { name: "My Agent", instructions });
```

`serve()` blocks until `SIGINT` or `SIGTERM`. Under `ast dev`, `GRPC_SERVER_ADDR` is injected automatically.

## API

### `serve(agent, options?)`

Connects the agent to the messaging service. Wraps the agent in an `AISDKAdapter`, registers the Astro OpenTelemetry tracer provider when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, and starts the gRPC listener.

| Option | Type | Description |
|--------|------|-------------|
| `name` | `string` | Display name shown in logs and the playground. Defaults to `agent.id`, then `"AI SDK Agent"`. |
| `instructions` | `string` | System prompt shown in the playground. The AI SDK `Agent` interface does not expose `instructions`, so pass yours through here to surface it. |
| `serverAddress` | `string` | Override the gRPC address. Defaults to `process.env.GRPC_SERVER_ADDR ?? "localhost:9090"`. |

### `AISDKAdapter`

The underlying `AgentAdapter` implementation. Use this directly if you need to compose it with other adapters or call `serve()` from `@astropods/adapter-core` yourself.

## Observability

The AI SDK emits OpenTelemetry spans when an agent is constructed with `experimental_telemetry: { isEnabled: true }`. This adapter does not enable that flag for you — set it on the agent — and registers the Astro tracer provider as the OpenTelemetry global, so spans flow into the dashboard automatically when deployed. Locally, `OTEL_EXPORTER_OTLP_ENDPOINT` is unset and the registration is skipped.

## Stream mapping

The adapter consumes `agent.stream({ prompt }).fullStream` and translates events into Astro's `StreamHooks` lifecycle:

| AI SDK event | Hook |
|--------------|------|
| `text-delta` | `onChunk(text)` |
| `reasoning-start` | `onStatusUpdate({ status: "THINKING" })` |
| `reasoning-end` | `onStatusUpdate({ status: "GENERATING" })` |
| `tool-input-start` | `onStatusUpdate({ status: "PROCESSING", customMessage: "Running ${toolName}" })` |
| `tool-input-end` | `onStatusUpdate({ status: "ANALYZING", customMessage: "Finished ${toolName}" })` |
| `tool-error` | `onError(error)` |
| `error` | `onError(error)` |
| `finish` | `onFinish()` |

Lifecycle and bookkeeping events (`start`, `start-step`, `finish-step`, `text-start`/`text-end`, `tool-input-delta`, `tool-call`, `tool-result`, `source`, `file`, `raw`) are ignored — they don't drive a visible state change in the playground or messaging clients.

## Troubleshooting

If traces don't show up in the dashboard:

- Confirm `experimental_telemetry: { isEnabled: true }` is set on the agent.
- Confirm `OTEL_EXPORTER_OTLP_ENDPOINT` is present in the deployed container.
- Check the agent container logs for OpenTelemetry export errors.
