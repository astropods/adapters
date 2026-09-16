# @astropods/adapter-core

Framework-agnostic bridge between TypeScript agents and the Astropods messaging service.

## Installation

```bash
bun add @astropods/adapter-core
# or
npm install @astropods/adapter-core
```

## Usage

If you're using a supported framework, use the pre-built adapter package instead (e.g. `@astropods/adapter-mastra`). Use this package directly to connect a custom or unsupported framework.

Implement the `AgentAdapter` interface, then call `serve()`:

```ts
import { serve } from "@astropods/adapter-core";
import type { AgentAdapter } from "@astropods/adapter-core";

const adapter: AgentAdapter = {
  name: "My Agent",
  async stream(prompt, hooks, options) {
    try {
      hooks.onChunk("Hello!");
      hooks.onFinish();
    } catch (err) {
      hooks.onError(err as Error);
    }
  },
  getConfig() {
    return { systemPrompt: "You are a helpful assistant.", tools: [] };
  },
};

serve(adapter);
```

`serve()` blocks until `SIGINT` or `SIGTERM`. Under `ast dev`, `GRPC_SERVER_ADDR` is injected automatically.

## API

### `AgentAdapter`

| Member | Description |
|--------|-------------|
| `name: string` | Display name used in logs and registration |
| `stream(prompt, hooks, options): Promise<void>` | Stream a response, invoking hooks as the agent progresses |
| `streamAudio?(audio, hooks, options): Promise<void>` | Optional — handle voice input |
| `getConfig(): AgentConfig` | Return `{ systemPrompt, tools }` for playground display |
| `onFeedback?(event): void \| Promise<void>` | Optional — receive inbound platform feedback (thumbs up/down, comments, button clicks) |

### `StreamHooks`

Call these inside `stream()` as the agent produces output:

| Method | When to call |
|--------|-------------|
| `onChunk(text)` | Each text token or fragment from the LLM |
| `onStatusUpdate({ status })` | Agent state change — valid values: `THINKING`, `SEARCHING`, `GENERATING`, `PROCESSING`, `ANALYZING`, `CUSTOM` |
| `onFinish()` | Response complete — call exactly once per request |
| `onError(error)` | Error occurred — call instead of `onFinish` |
| `onTraceContext({ traceparent })` | Optional — once per turn, to supply the W3C trace context of the assistant turn. The bridge stamps it on every response it emits for the turn, so a consumer can correlate any response back to its trace. Ignored if `traceparent` is empty. |

### `createTraceparent(input)`

Formats a native trace/span ID pair into a W3C `traceparent` string to hand to `onTraceContext`. Returns `""` for invalid or all-zero IDs, so it's safe to pass raw OpenTelemetry span context. `traceFlags` accepts a number or hex string and defaults to `01` (sampled).

```ts
import { createTraceparent } from "@astropods/adapter-core";

const { traceId, spanId, traceFlags } = span.spanContext();
hooks.onTraceContext?.({ traceparent: createTraceparent({ traceId, spanId, traceFlags }) });
```

### `StreamOptions`

Per-request context passed to `stream()`:

| Field | Description |
|-------|-------------|
| `conversationId` | Stable ID for the conversation thread |
| `userId` | ID of the user who sent the message |
| `platformContext?` | `PlatformContext \| undefined` — platform-specific fields (channel, thread, workspace, event kind). `undefined` for messages from non-platform sources (playground, direct gRPC). |

#### Using `platformContext`

`PlatformContext` exposes the source-event fields adapters often need to branch on — the channel and thread to reply into, the workspace, the bot's own user ID, and an `eventKind` enum that distinguishes a DM from an @-mention from a thread reply without having to inspect message content.

```ts
import type { AgentAdapter, PlatformContext } from "@astropods/adapter-core";

const adapter: AgentAdapter = {
  name: "My Agent",
  async stream(prompt, hooks, { platformContext }) {
    if (platformContext?.eventKind === "EVENT_KIND_APP_MENTION") {
      hooks.onChunk(`You @-mentioned me in ${platformContext.channelName ?? platformContext.channelId}.`);
    } else {
      hooks.onChunk("Hello!");
    }
    hooks.onFinish();
  },
  getConfig() {
    return { systemPrompt: "", tools: [] };
  },
};
```

Always null-check first — `platformContext` is `undefined` for messages from the playground or direct gRPC clients. See [`PlatformContext`](https://github.com/astropods/messaging/blob/main/proto/astro/messaging/v1/message.proto) for the full field list.

### `serve(adapter, options?)`

Connects the adapter to the messaging service and blocks until shutdown.

```ts
import { serve } from "@astropods/adapter-core";

// Override the gRPC address (default: GRPC_SERVER_ADDR env var or localhost:9090)
serve(adapter, { serverAddress: "astro-messaging:9090" });
```

### `MessagingBridge`

`serve()` is a thin wrapper around `MessagingBridge`. Use it directly if you need lifecycle control:

```ts
import { MessagingBridge } from "@astropods/adapter-core";

const bridge = new MessagingBridge(adapter);
await bridge.start();
```

## HTTP outbound instrumentation

`@astropods/adapter-core/instrument` patches `globalThis.fetch` so every outbound HTTP request becomes an OpenTelemetry CLIENT span. Spans are sent to `${OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`. When that env var is unset, the import is a no-op.

Import it **once, before any code that issues fetch** — typically the first line of your entry point:

```ts
import "@astropods/adapter-core/instrument";
// ...the rest of your imports
```

Or call it explicitly:

```ts
import { instrumentHttp } from "@astropods/adapter-core";

instrumentHttp();
```

Both forms are idempotent and share a tracer provider with other Astropods adapters in the same process.

## Sandboxes

A sandbox is an isolated machine an agent creates to run commands and hold
files for one conversation. It sleeps when the conversation goes quiet and
bills for the compute it uses.

```ts
import { SandboxClient } from "@astropods/adapter-core/sandbox";

const sandboxes = new SandboxClient();

const result = await sandboxes.exec(conversationId, {
  command: ["/bin/sh", "-c", "npm test"],
});
console.log(result.exitCode, result.stdout);
```

`new SandboxClient()` reads `ASTRO_AUTHZ_TOKEN` from the environment and takes
the server URL from that token, so nothing has to be configured.

Call `exec` on every turn. It attaches on the first call for a name and reuses
the sandbox after, and the server settles two concurrent first calls onto one
sandbox rather than two. Key by conversation or thread id: two conversations
sharing one sandbox share its files.

| Method | Does |
|---|---|
| `exec(name, request)` | Attaches if needed, then runs a command |
| `attach(name, class?)` | Returns a handle without running anything |
| `get(name)` / `list()` | Records, with no credentials in them |
| `stop(name)` | Stops compute early. Optional; an idle sandbox sleeps on its own |
| `delete(name)` | Drops the sandbox and its files |

A non-zero exit code and a timed-out command are both results, not thrown
errors: check `exitCode` and `timedOut`. Thrown errors mean the request itself
failed. `SandboxNotEnabledError` means the account has not turned sandboxes
on, in account or organization settings.

The endpoint and the two credentials a sandbox needs are not part of this
surface. The client refreshes them, and re-attaches once when a sandbox has
been replaced, so an agent never handles either.

### Limits

Output is buffered until a command exits and capped at 1 MiB per stream, and
there is no way to stream it, poll a background process or signal one. A
sandbox lives at most 8 hours; after that the next `exec` gets a fresh one with
an empty workspace. Files do not survive that.
