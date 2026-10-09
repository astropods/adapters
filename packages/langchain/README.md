# astropods-adapter-langchain

LangChain adapter for the Astropods messaging service. Wraps a `create_agent` executor and connects it to the Astro runtime.

## Installation

```bash
pip install astropods-adapter-langchain
```

Requires Python 3.10+.

## Usage

```python
from langchain_anthropic import ChatAnthropic
from langchain.agents import create_agent
from astropods_adapter_langchain import LangChainAdapter, serve

llm = ChatAnthropic(model="claude-sonnet-4-5")
system_prompt = "You are a helpful assistant."
agent = create_agent(llm, tools=[], system_prompt=system_prompt)

adapter = LangChainAdapter(agent, name="My Agent", system_prompt=system_prompt)
serve(adapter)
```

`serve()` blocks until `SIGINT` or `SIGTERM`. Under `ast dev`, `GRPC_SERVER_ADDR` is injected automatically.

### The sender's name

`configurable["user_name"]` carries the sender's name on the source platform (their full name in Slack, or their Astro name in web chat). It is absent when the platform sent none. A tool reads it from its run config:

```python
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool

@tool
def who_am_i(config: RunnableConfig) -> str:
    """Name the current user."""
    return config["configurable"].get("user_name", "unknown")
```

## API

### `LangChainAdapter(executor, name, system_prompt?, tools?)`

| Parameter | Type | Description |
|-----------|------|-------------|
| `executor` | LangChain agent | A compiled agent, e.g. from `create_agent` |
| `name` | `str` | Display name shown in logs and the playground |
| `system_prompt` | `str` | Shown in the playground's config panel |
| `tools` | `list` | LangChain tool objects — populates the playground tool list |

### `serve(adapter, options?)`

Re-exported from `astropods-adapter-core`. Connects the adapter to the messaging service and blocks until shutdown. Pass a `ServeOptions(server_address="...")` as the second argument to override the gRPC address.
