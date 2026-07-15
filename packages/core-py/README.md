# astropods-adapter-core

Framework-agnostic bridge between Python agents and the Astropods messaging service.

## Installation

```bash
pip install astropods-adapter-core
```

Requires Python 3.10+.

## Usage

If you're using a supported framework, use the pre-built adapter package instead (e.g. `astropods-adapter-langchain`). Use this package directly to connect a custom or unsupported framework.

Create a class with `name`, `stream`, and `get_config`, then call `serve()`:

```python
from astropods_adapter_core import StreamHooks, StreamOptions, serve

class MyAdapter:
    name = "My Agent"

    async def stream(self, prompt: str, hooks: StreamHooks, options: StreamOptions) -> None:
        try:
            hooks.on_chunk("Hello!")
            hooks.on_finish()
        except Exception as e:
            hooks.on_error(e)

    def get_config(self) -> dict:
        return {"system_prompt": "You are a helpful assistant.", "tools": []}

serve(MyAdapter())
```

`serve()` blocks until `SIGINT` or `SIGTERM`. Under `ast dev`, `GRPC_SERVER_ADDR` is injected automatically.

## API

### `AgentAdapter` protocol

| Member | Description |
|--------|-------------|
| `name: str` | Display name used in logs and registration |
| `async stream(prompt, hooks, options)` | Stream a response, invoking hooks as the agent progresses |
| `get_config() -> dict` | Return `{"system_prompt": str, "tools": [...]}` for playground display |

### `StreamHooks`

Call these inside `stream()` as the agent produces output:

| Method | When to call |
|--------|-------------|
| `on_chunk(text)` | Each text token or fragment from the LLM |
| `on_status_update({"status": "..."})` | Agent state change — valid values: `THINKING`, `SEARCHING`, `GENERATING`, `PROCESSING`, `ANALYZING`, `CUSTOM` |
| `on_finish()` | Response complete — call exactly once per request |
| `on_error(exception)` | Error occurred — call instead of `on_finish` |

`on_trace_context(trace_context)` is optional; call it with `getattr` when a turn has W3C trace context.

For `CUSTOM` status, include `"custom_message"` in the dict:

```python
hooks.on_status_update({"status": "CUSTOM", "custom_message": "Fetching data..."})
```

### `create_traceparent(*, trace_id, span_id, trace_flags="01")`

Formats a native trace/span ID pair into a W3C `traceparent` string to hand to `on_trace_context`. Returns `""` for invalid or all-zero IDs, so it's safe to pass raw OpenTelemetry span context. `trace_flags` accepts an int or hex string and defaults to `"01"` (sampled).

```python
from astropods_messaging import TraceContext
from astropods_adapter_core import create_traceparent

ctx = span.get_span_context()
traceparent = create_traceparent(
    trace_id=f"{ctx.trace_id:032x}",
    span_id=f"{ctx.span_id:016x}",
    trace_flags=int(ctx.trace_flags),
)
if traceparent:
    on_trace_context = getattr(hooks, "on_trace_context", None)
    if on_trace_context is not None:
        on_trace_context(TraceContext(traceparent=traceparent))
```

### `StreamOptions`

Per-request context passed to `stream()`:

| Field | Description |
|-------|-------------|
| `conversation_id` | Stable ID for the conversation thread |
| `user_id` | ID of the user who sent the message |
| `platform_context` | `Optional[PlatformContext]` — platform-specific fields (channel, thread, workspace, event kind). `None` for messages from non-platform sources (playground, direct gRPC). |

#### Using `platform_context`

`PlatformContext` exposes the source-event fields adapters often need to branch on — the channel and thread to reply into, the workspace, the bot's own user ID, and an `event_kind` enum that distinguishes a DM from an @-mention from a thread reply without having to inspect message content.

```python
from astropods_adapter_core import PlatformContext, StreamHooks, StreamOptions

async def stream(self, prompt, hooks: StreamHooks, options: StreamOptions) -> None:
    pc = options.platform_context
    if pc and pc.event_kind == PlatformContext.EVENT_KIND_APP_MENTION:
        hooks.on_chunk(f"You @-mentioned me in {pc.channel_name or pc.channel_id}.")
    else:
        hooks.on_chunk("Hello!")
    hooks.on_finish()
```

Always null-check first — `platform_context` is `None` for messages from the playground or direct gRPC clients. See [`PlatformContext`](https://github.com/astropods/messaging/blob/main/proto/astro/messaging/v1/message.proto) for the full field list.

### `serve(adapter, options?)`

Connects the adapter to the messaging service and blocks until shutdown.

```python
from astropods_adapter_core import ServeOptions, serve

# Override the gRPC address (default: GRPC_SERVER_ADDR env var or localhost:9090)
serve(adapter, ServeOptions(server_address="astro-messaging:9090"))
```

### `MessagingBridge`

`serve()` is a thin wrapper around `MessagingBridge`. Use it directly if you need lifecycle control:

```python
import asyncio
from astropods_adapter_core import MessagingBridge

bridge = MessagingBridge(adapter)
asyncio.run(bridge.start())
```
