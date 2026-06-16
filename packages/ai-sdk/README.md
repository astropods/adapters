# @astropods/adapter-ai-sdk

Vercel AI SDK adapter for Astro. Wrap a `ToolLoopAgent` and pass it to `serve()` to run it on Astro's messaging service. Spread `astroTelemetry()` into the agent settings to send OpenTelemetry spans to the Astro dashboard.

Targets `ai >= 6.0.0`.

## Installation

```bash
bun add @astropods/adapter-ai-sdk
```

## Usage

Spread `astroTelemetry()` into `experimental_telemetry`, then pass the agent to `serve()`:

```typescript
import { Experimental_Agent as Agent } from "ai";
import { openai } from "@ai-sdk/openai";
import { serve, astroTelemetry } from "@astropods/adapter-ai-sdk";

const instructions = "You are a helpful assistant.";

const agent = new Agent({
  model: openai("gpt-4o"),
  instructions,
  experimental_telemetry: astroTelemetry(),
});

serve(agent, { name: "My Agent", instructions });
```

`serve()` blocks until `SIGINT` or `SIGTERM`. Under `ast dev`, the CLI injects `GRPC_SERVER_ADDR` for you.

### Observability without messaging

If you serve the agent from your own framework (Next.js, Express, Lambda) and want spans in the dashboard, use `astroTelemetry()` on its own:

```typescript
import { Experimental_Agent as Agent } from "ai";
import { astroTelemetry } from "@astropods/adapter-ai-sdk";

const agent = new Agent({
  model: openai("gpt-4o"),
  experimental_telemetry: astroTelemetry(),
});
```

## API

### `serve(agent, options?)`

Connects the agent to the messaging service.

| Option | Type | Description |
|--------|------|-------------|
| `name` | `string` | Display name shown in logs and the playground. Defaults to `agent.id`, then `"AI SDK Agent"`. |
| `instructions` | `string` | System prompt shown in the playground. The AI SDK `Agent` interface exposes no `instructions` field, so pass yours here. |
| `serverAddress` | `string` | Override the gRPC address. Defaults to `process.env.GRPC_SERVER_ADDR ?? "localhost:9090"`. |

### `astroTelemetry()`

Returns `experimental_telemetry` settings for the AI SDK, wired to Astro's OTLP exporter. The helper builds the tracer from an unregistered `NodeTracerProvider`, so it does not modify the OpenTelemetry global.

- `OTEL_EXPORTER_OTLP_ENDPOINT` set: returns `{ isEnabled: true, tracer }`.
- Env var unset (local dev): returns `{ isEnabled: false }`. The AI SDK skips telemetry.

Spread it on top of your own settings to add a `functionId` or `metadata`:

```typescript
experimental_telemetry: { ...astroTelemetry(), functionId: "myAgent" }
```

### `AISDKAdapter`

The underlying `AgentAdapter` implementation. Use it to compose with other adapters or to call `serve()` from `@astropods/adapter-core`.

## Stream mapping

The adapter reads `agent.stream({ prompt }).fullStream` and maps each event to a `StreamHooks` call:

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

The adapter ignores these events: `start`, `start-step`, `finish-step`, `text-start`, `text-end`, `tool-input-delta`, `tool-call`, `tool-result`, `source`, `file`, `raw`. None of them change what the playground or messaging clients display.

## Troubleshooting

If spans don't show up:

- Confirm `experimental_telemetry: astroTelemetry()` is on the agent.
- Confirm `OTEL_EXPORTER_OTLP_ENDPOINT` is set in the deployed container.
- Check the container logs for OpenTelemetry export errors.
