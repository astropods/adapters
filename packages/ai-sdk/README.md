# @astropods/adapter-ai-sdk

Vercel AI SDK adapter for the Astro platform. Wraps a `ToolLoopAgent` (the v6 `Experimental_Agent` class) so it can run on Astro's messaging service, and exposes an explicit `astroTelemetry()` helper that routes the SDK's OpenTelemetry spans into the Astro dashboard.

## Installation

```bash
bun add @astropods/adapter-ai-sdk
```

Requires `ai >= 6.0.0`.

## Use

Pass `astroTelemetry()` into the agent's `experimental_telemetry` and pass the agent to `serve()`:

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

`serve()` blocks until `SIGINT` or `SIGTERM`. Under `ast dev`, `GRPC_SERVER_ADDR` is injected automatically.

### Observability without messaging

If you're not using Astro's messaging service (e.g. you're already serving the agent from your own HTTP framework) but still want spans in the Astro dashboard, `astroTelemetry()` alone is enough:

```typescript
import { Experimental_Agent as Agent } from "ai";
import { astroTelemetry } from "@astropods/adapter-ai-sdk";

const agent = new Agent({
  model: openai("gpt-4o"),
  experimental_telemetry: astroTelemetry(),
});

// Use the agent however you like — Next.js route, Express handler, etc.
```

## API

### `serve(agent, options?)`

Connects the agent to the messaging service. Pure messaging — no observability side effects.

| Option | Type | Description |
|--------|------|-------------|
| `name` | `string` | Display name shown in logs and the playground. Defaults to `agent.id`, then `"AI SDK Agent"`. |
| `instructions` | `string` | System prompt shown in the playground. The AI SDK `Agent` interface does not expose `instructions`, so pass them through here. |
| `serverAddress` | `string` | Override the gRPC address. Defaults to `process.env.GRPC_SERVER_ADDR ?? "localhost:9090"`. |

### `astroTelemetry()`

Returns `experimental_telemetry` settings for the AI SDK, wired to Astro's OTLP exporter. No global mutation — the tracer is delivered explicitly.

- Returns `{ isEnabled: true, tracer }` when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
- Returns `{ isEnabled: false }` when the env var is unset (e.g. local dev). The AI SDK skips telemetry entirely.

Spread it on top of your own settings if you also want a `functionId` or `metadata`:

```typescript
experimental_telemetry: { ...astroTelemetry(), functionId: "myAgent" }
```

### `AISDKAdapter`

The underlying `AgentAdapter` implementation. Use it directly if you want to compose with other adapters or call `serve()` from `@astropods/adapter-core` yourself.

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

- Confirm `experimental_telemetry: astroTelemetry()` is set on the agent.
- Confirm `OTEL_EXPORTER_OTLP_ENDPOINT` is present in the deployed container.
- Check the agent container logs for OpenTelemetry export errors.
