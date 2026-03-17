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
