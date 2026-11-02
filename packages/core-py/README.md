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

### `attach_file(name, data=None, mime_type=None)`

Writes a file to the agent's files dir (`AGENT_FILES_DIR`) and attaches it to the reply. Web chat shows it as a download chip, and Slack uploads it into the thread. Call it from a tool while the agent handles a message, sync or async. It raises outside one.

```python
from astropods_adapter_core import attach_file

attach_file("account-plan.csv", csv_text, "text/csv")
```

`name` is one path segment. Omit `data` to attach a file that is already in the files dir. It returns the file's name. Every user's files share that dir, so with `data` a name already there gets a number: `summary.md` becomes `summary-2.md`. A file over the deployment's file size limit (`FILES_MAX_MB`, 100 MiB when unset, `0` for no limit) raises `ValueError`, so the agent knows before it replies.

### Reading attached files

These functions read the files a user attaches. Each takes the `path` from `StreamOptions.attachments`. The LangChain adapter wraps them as tools in `file_tools()`.

| Function | Returns |
|----------|---------|
| `inspect_file(path)` | The file's kind (`pdf`, `docx`, `xlsx`, `zip`, `text`, `binary`), its size, its text length, and for a table each sheet's columns and exact row count. The kind is read from the bytes, because staged uploads have no extension. A PDF with no text layer, such as a scan, has `scanned: True`. |
| `read_file_page(path, offset=0)` | One `PAGE_CHARS` (20,000-character) page of a PDF, DOCX, or text file, with `next_offset` (`None` on the last page) and `total_chars`. It raises for a PDF with no text layer, which needs OCR. |
| `read_table(path, sheet=None, offset=0, limit=PAGE_ROWS)` | One page of a CSV or XLSX table: the header as `columns`, then `limit` data rows (`PAGE_ROWS`, 100, by default, at most 500) starting at `offset`, with `next_offset`. A CSV or XLSX sheet is streamed, so a page late in a large file does not load the whole file. CSV cells are strings. XLSX cells keep their types, and dates become ISO strings. |
| `create_file(name, content, mime_type=None)` | Writes a text file with `attach_file` and returns `{"attached": ..., "path": ...}`: the name the user sees and the path the read functions open in a later turn. |
| `attachment_note(attachments, images=())` | The line an adapter appends to the turn's text that names each attached file and its path. |

Every thread's and user's files share `AGENT_FILES_DIR`, so the functions open only the files the current conversation received as attachments or wrote with `attach_file`, and they raise outside a turn. The bridge keeps that list in memory for the 1,000 most recent conversations, up to 100 files each. After the agent restarts, the user attaches an earlier file again. In Slack, a mention in a thread also attaches the thread's earlier files again.

The functions deliver a file's contents and do no analysis. For counts or totals over a large table, give the agent a tool that runs pandas or DuckDB on the attachment's `path`, after passing it through `resolve_agent_file`, which raises for any file the conversation did not receive or create. `pypdf`, `mammoth`, and `openpyxl` load only when an agent reads a file of that kind.

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
| `user_name` | The sender's name on the source platform, such as their full name in Slack. Empty when the platform sent none. |
| `platform_context` | `Optional[PlatformContext]` — platform-specific fields (channel, thread, workspace, event kind). `None` for messages from non-platform sources (playground, direct gRPC). |
| `history` | `Optional[HistoryInput]`: the turns before this message, set only when they differ from what the agent last answered. Replace what you store for `conversation_id` with `history.messages`, then handle the prompt. Report `"supports_history": True` from `get_config()`; the chat offers message editing only then. |
| `model` | `str`: the model id the user picked in chat, always one of `get_config()["models"]` (the bridge drops any other); empty when none was picked. Pass it to your framework where it picks the model for a run. |

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

## Connections

A connection is a third-party account, such as GitHub, that the chatting user
lets the agent use as them. Install the `connections` extra:

```sh
pip install "astropods-adapter-core[connections]"
```

```python
from astropods_adapter_core.connections import ConnectionClient, ConnectionTokenError

connections = ConnectionClient()

token = connections.get_token("github", user_id)
token = await connections.get_token_async("github", user_id)
```

`ConnectionClient()` reads `ASTRO_AUTHZ_TOKEN` and takes the server URL from
it. The server returns a token only for a user who allowed this agent and has
messaged it in web chat in the last 15 minutes. A refusal raises
`ConnectionTokenError` with `code` set to `not_consented`, `not_active`,
`not_connected`, `needs_reauthorization`, or `unavailable`.
