# @astropods/adapter-langchain

`@astropods/adapter-langchain` exports two functions you can use independently:

- `instrumentLangChain()` wires LangChain's OpenTelemetry tracing to Astro's OTLP exporter.
- `serve()` connects a LangChain/LangGraph agent to Astro's messaging service to make your agent compatible with the Astropods playground.

Targets `langchain >= 1.0.0` (and `@langchain/core >= 1.0.0`).

## Install

```bash
bun add @astropods/adapter-langchain
```

## Send telemetry to Astro

Call `instrumentLangChain()` once at startup:

```typescript
import { createAgent } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import { instrumentLangChain } from "@astropods/adapter-langchain";

instrumentLangChain();

const agent = createAgent({
  model: new ChatOpenAI({ model: "gpt-4o" }),
  tools: [getWeather],
  prompt: "You are a helpful assistant.",
});
```

Use this on its own when you serve the agent from your own framework and want LangChain traces (chains, model calls, tool calls) reported in the dashboard.

Instrumentation is **process-global**: it patches LangChain's shared callback manager (the only injection point OpenInference exposes), so every LangChain run in the process is traced. It is an explicit, opt-in call — nothing is patched on import — and a no-op when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset (local dev).

## Serve over Astro messaging

To run the agent on Astro messaging, pass it to `serve()`:

```typescript
import { createAgent } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import { serve } from "@astropods/adapter-langchain";

const instructions = "You are a helpful assistant.";

const agent = createAgent({
  model: new ChatOpenAI({ model: "gpt-4o" }),
  tools: [getWeather],
  prompt: instructions,
});

serve(agent, { name: "My Agent", instructions, tools: [getWeather] });
```

`serve()` calls `instrumentLangChain()` for you by default. Pass `{ instrument: false }` to opt out.

Passing `instructions` and `tools` lets your system prompt and tool list show in the Astropods playground — the compiled graph does not expose them, so they are supplied here. Both are optional; omit `instructions` to hide your prompt.

`serve()` blocks until `SIGINT` or `SIGTERM`. Under `ast dev`, the CLI injects `GRPC_SERVER_ADDR` for you.

## API

### `serve(agent, options?)`

Connects the agent to the messaging service.

| Option | Type | Description |
|--------|------|-------------|
| `name` | `string` | Display name shown in logs and the playground. Defaults to `"LangChain Agent"`. |
| `instructions` | `string` | Optional. System prompt shown in the playground when provided. |
| `tools` | `Array<{ name?, description? }>` | Optional. The agent's tools, for the playground's tool list. |
| `instrument` | `boolean` | Enable process-global instrumentation before serving. Defaults to `true`. |
| `serverAddress` | `string` | Override the gRPC address. Defaults to `process.env.GRPC_SERVER_ADDR ?? "localhost:9090"`. |

### `instrumentLangChain()`

Enables OpenTelemetry tracing for LangChain, wired to Astro's OTLP exporter via OpenInference. Returns `true` when instrumentation was enabled, `false` when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset. Idempotent.

### `LangChainAdapter`

The underlying `AgentAdapter` implementation. Use it to compose with other adapters or to call `serve()` from `@astropods/adapter-core`.

## Stream mapping

The adapter reads `agent.stream({ messages }, { streamMode: ["messages", "updates"] })` and maps each event to a `StreamHooks` call:

| LangGraph event | Hook |
|--------------|------|
| assistant `text` content block | `onChunk(text)` |
| assistant `reasoning` content block | `onStatusUpdate({ status: "THINKING" })` (once), then `GENERATING` on the next text |
| tool call on the `model`/`agent` node | `onStatusUpdate({ status: "PROCESSING", customMessage: "Running ${toolName}" })` |
| tool result on the `tools` node | `onStatusUpdate({ status: "ANALYZING", customMessage: "Finished ${toolName}" })` |
| stream throws | `onError(error)` |
| stream completes | `onFinish()` |

Tool-result messages that also stream through `messages` mode are skipped — only the assistant's own messages surface as chat text.

## Troubleshooting

If nothing shows up:

- Confirm `instrumentLangChain()` was called (or `serve()` ran without `{ instrument: false }`).
- Confirm `OTEL_EXPORTER_OTLP_ENDPOINT` is set in the deployed container.
- Check the container logs for OpenTelemetry export errors.
