# @astropods/adapter-ai-sdk

`@astropods/adapter-ai-sdk` exports two functions you can use independently:

- `astroTelemetry()` returns AI SDK `experimental_telemetry` settings wired to Astro's OTLP exporter.
- `serve()` connects a `ToolLoopAgent` (`Experimental_Agent`) to Astro's messaging service to make your agent compatible with the Astropods playground.

Targets `ai >= 6.0.0`.

## Install

```bash
bun add @astropods/adapter-ai-sdk
```

## Send telemetry to Astro

Add `astroTelemetry()` into the agent's `experimental_telemetry`:

```typescript
import { Experimental_Agent as Agent } from "ai";
import { openai } from "@ai-sdk/openai";
import { astroTelemetry } from "@astropods/adapter-ai-sdk";

const agent = new Agent({
  model: openai("gpt-4o"),
  instructions: "You are a helpful assistant.",
  experimental_telemetry: astroTelemetry(),
});
```

Use this on its own when you serve the agent from your own framework and want AI traces reported in the dashboard.

## Serve over Astro messaging

To run the agent on Astro messaging, pass it to `serve()`:

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

Passing `instructions` into the `serve()` function allows your agent's system prompt to be visible in the Astropods playground. This is optional. To hide your prompts exclude `instructions` from the `serve` call.

`serve()` blocks until `SIGINT` or `SIGTERM`. Under `ast dev`, the CLI injects `GRPC_SERVER_ADDR` for you.

## The sender's name

An AI SDK agent reads per-turn context through its call options. Declare them on the agent, then map each turn's `StreamOptions` onto them with `callOptions`. `userName` is the sender's display name on the source platform (their Slack display name, or their Astro name in web chat), and is absent when the platform sent none. Tell the model how to use the name, or it may repeat it in every reply.

```typescript
import { ToolLoopAgent } from "ai";
import { z } from "zod";

const agent = new ToolLoopAgent({
  model: openai("gpt-4o"),
  callOptionsSchema: z.object({ userName: z.string().optional() }),
  prepareCall: ({ options, ...rest }) => ({
    ...rest,
    instructions: options.userName
      ? `The user's name is ${options.userName}. Greet them by name in your first reply only; don't repeat it after that.`
      : "You are a helpful assistant.",
  }),
});

serve(agent, {
  name: "My Agent",
  callOptions: (turn) => ({ userName: turn.userName }),
});
```

An agent without call options needs no `callOptions`.

## API

### `serve(agent, options?)`

Connects the agent to the messaging service.

| Option | Type | Description |
|--------|------|-------------|
| `name` | `string` | Display name shown in logs and the playground. Defaults to `agent.id`, then `"AI SDK Agent"`. |
| `instructions` | `string` | Optional. System prompt shown in the playground when provided. |
| `callOptions` | `(options: StreamOptions) => CALL_OPTIONS` | Optional. Builds the agent's call options for each turn. See [The sender's name](#the-senders-name). |
| `serverAddress` | `string` | Override the gRPC address. Defaults to `process.env.GRPC_SERVER_ADDR ?? "localhost:9090"`. |

### `astroTelemetry()`

Returns `experimental_telemetry` settings for the AI SDK, wired to Astro's OTLP exporter. The helper builds the tracer from an unregistered `NodeTracerProvider`, so it does not modify the OpenTelemetry global.

- `OTEL_EXPORTER_OTLP_ENDPOINT` set: returns `{ isEnabled: true, tracer, integrations }`. AI SDK 6 reads `tracer`. AI SDK 7 ignores `tracer` and sends spans only to telemetry integrations, so `integrations` holds an `@ai-sdk/otel` `OpenTelemetry` integration built on the same tracer.
- Env var unset (local dev): returns `{ isEnabled: false }`. The AI SDK skips telemetry.

On AI SDK 7, pass the settings as the agent's `telemetry` option, for example `new ToolLoopAgent({ model, telemetry: astroTelemetry() })`.

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

If nothing shows up:

- Confirm `experimental_telemetry: astroTelemetry()` is on the agent.
- Confirm `OTEL_EXPORTER_OTLP_ENDPOINT` is set in the deployed container.
- Check the container logs for OpenTelemetry export errors.
