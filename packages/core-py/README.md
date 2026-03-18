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

For `CUSTOM` status, include `"custom_message"` in the dict:

```python
hooks.on_status_update({"status": "CUSTOM", "custom_message": "Fetching data..."})
```

### `StreamOptions`

Per-request context passed to `stream()`:

| Field | Description |
|-------|-------------|
| `conversation_id` | Stable ID for the conversation thread |
| `user_id` | ID of the user who sent the message |

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
