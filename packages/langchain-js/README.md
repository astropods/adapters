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
  systemPrompt: "You are a helpful assistant.",
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

const agent = createAgent({
  model: new ChatOpenAI({ model: "gpt-4o" }),
  tools: [getWeather],
  systemPrompt: "You are a helpful assistant.",
});

serve(agent, { name: "My Agent" });
```

`serve()` calls `instrumentLangChain()` for you by default. Pass `{ instrument: false }` to opt out.

The playground shows your system prompt and tool list. For agents built with `createAgent`, both are read automatically from the agent (`agent.options.systemPrompt` and `agent.options.tools`) — you don't repeat them. Pass `instructions`/`tools` to `serve()` only to override, or to supply them for agents that don't expose `options` (e.g. a raw compiled graph or `createReactAgent` from `@langchain/langgraph`).

`serve()` blocks until `SIGINT` or `SIGTERM`. Under `ast dev`, the CLI injects `GRPC_SERVER_ADDR` for you.

### Supported agents

`serve()` and `LangChainAdapter` expect a **LangGraph agent** — `createAgent` (langchain) or `createReactAgent` (`@langchain/langgraph`). The adapter drives `agent.stream(..., { streamMode: ["messages", "updates"] })`, which is a LangGraph feature. Plain LCEL runnables (`prompt.pipe(model).pipe(parser)`) and bare chat models also have a `.stream()` but don't emit LangGraph's stream events, so they aren't supported.

### Conversation memory

The adapter sends only the latest user message each turn, keyed by `thread_id` (the conversation id), and relies on the agent's **checkpointer** to restore prior turns — the standard LangGraph pattern. `createAgent`/`createReactAgent` have no checkpointer by default, so `serve()` installs an in-process `MemorySaver` when the agent has none, making multi-turn chat work out of the box.

The in-process saver is not durable (state is lost on restart) and grows with the number of conversations, so for production configure a durable checkpointer on the agent — it is always respected and never replaced:

```typescript
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

const agent = createAgent({ model, tools, checkpointer: postgresSaver });
serve(agent, { name: "My Agent" }); // your checkpointer is kept as-is
```

For stateless replies, pass `{ memory: false }` to `serve()` or set `checkpointer: false` on the agent — both are honored.

### Per-run configuration

`serve()` controls the stream's `streamMode` and `thread_id`. To set other run options — `recursionLimit`, `tags`, a `store` — configure them on the agent before serving with [`agent.withConfig(...)`](https://docs.langchain.com/oss/javascript/langchain/agents), which `serve()` preserves:

```typescript
serve(agent.withConfig({ recursionLimit: 100 }), { name: "My Agent" });
```

## API

### `serve(agent, options?)`

Connects the agent to the messaging service.

| Option | Type | Description |
|--------|------|-------------|
| `name` | `string` | Display name shown in logs and the playground. Defaults to `"LangChain Agent"`. |
| `instructions` | `string` | Optional. Overrides the system prompt shown in the playground (auto-read from `agent.options.systemPrompt`). |
| `tools` | `Array<{ name?, description? }>` | Optional. Overrides the playground's tool list (auto-read from `agent.options.tools`). |
| `instrument` | `boolean` | Enable process-global instrumentation before serving. Defaults to `true`. |
| `memory` | `boolean` | Install an in-process `MemorySaver` when the agent has no checkpointer. Defaults to `true`. A checkpointer configured on the agent is always respected. |
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

Tool status is read from the `model`/`agent` and `tools` nodes that `createAgent`/`createReactAgent` produce. A custom graph with differently named nodes still streams its assistant text, but won't surface the `PROCESSING`/`ANALYZING` tool-status updates.

## Troubleshooting

If nothing shows up:

- Confirm `instrumentLangChain()` was called (or `serve()` ran without `{ instrument: false }`).
- Confirm `OTEL_EXPORTER_OTLP_ENDPOINT` is set in the deployed container.
- Check the container logs for OpenTelemetry export errors.

If the agent doesn't remember earlier turns, a checkpointer isn't active — check that `serve()` wasn't called with `{ memory: false }`, or configure a durable checkpointer on the agent.
