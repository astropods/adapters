import pytest
from unittest.mock import MagicMock, call

from astropods_adapter_langchain import LangChainAdapter
from conftest import make_event, make_executor_with_events


def make_chunk_event(content: str) -> dict:
    chunk = MagicMock()
    chunk.content = content
    return {"event": "on_chat_model_stream", "data": {"chunk": chunk}, "name": ""}


def make_tool_event(kind: str, tool_name: str) -> dict:
    return {"event": kind, "data": {}, "name": tool_name}


class TestLangChainAdapterName:
    def test_name_set_from_constructor(self):
        executor = MagicMock()
        adapter = LangChainAdapter(executor, name="My Agent")
        assert adapter.name == "My Agent"

    def test_default_name(self):
        executor = MagicMock()
        adapter = LangChainAdapter(executor)
        assert adapter.name == "LangChain Agent"


class TestLangChainAdapterStream:
    @pytest.mark.asyncio
    async def test_on_chat_model_stream_calls_on_chunk(self, hooks, stream_options):
        events = [
            make_chunk_event("Hello"),
            make_chunk_event(", "),
            make_chunk_event("world"),
        ]
        executor = make_executor_with_events(events)
        adapter = LangChainAdapter(executor)

        await adapter.stream("hi", hooks, stream_options)

        assert hooks.on_chunk.call_count == 3
        hooks.on_chunk.assert_any_call("Hello")
        hooks.on_chunk.assert_any_call(", ")
        hooks.on_chunk.assert_any_call("world")

    @pytest.mark.asyncio
    async def test_empty_chunk_content_is_skipped(self, hooks, stream_options):
        chunk = MagicMock()
        chunk.content = ""
        events = [{"event": "on_chat_model_stream", "data": {"chunk": chunk}, "name": ""}]
        executor = make_executor_with_events(events)
        adapter = LangChainAdapter(executor)

        await adapter.stream("hi", hooks, stream_options)

        hooks.on_chunk.assert_not_called()
        hooks.on_finish.assert_called_once()

    @pytest.mark.asyncio
    async def test_on_tool_start_calls_on_status_update_processing(self, hooks, stream_options):
        events = [make_tool_event("on_tool_start", "search_tool")]
        executor = make_executor_with_events(events)
        adapter = LangChainAdapter(executor)

        await adapter.stream("hi", hooks, stream_options)

        hooks.on_status_update.assert_any_call({
            "status": "PROCESSING",
            "custom_message": "Running search_tool",
        })

    @pytest.mark.asyncio
    async def test_on_tool_end_calls_on_status_update_analyzing(self, hooks, stream_options):
        events = [make_tool_event("on_tool_end", "search_tool")]
        executor = make_executor_with_events(events)
        adapter = LangChainAdapter(executor)

        await adapter.stream("hi", hooks, stream_options)

        hooks.on_status_update.assert_any_call({
            "status": "ANALYZING",
            "custom_message": "Finished search_tool",
        })

    @pytest.mark.asyncio
    async def test_on_finish_called_after_stream_completes(self, hooks, stream_options):
        events = [make_chunk_event("response")]
        executor = make_executor_with_events(events)
        adapter = LangChainAdapter(executor)

        await adapter.stream("hi", hooks, stream_options)

        hooks.on_finish.assert_called_once()

    @pytest.mark.asyncio
    async def test_exception_calls_on_error_not_on_finish(self, hooks, stream_options):
        executor = MagicMock()

        async def astream_events(*args, **kwargs):
            raise RuntimeError("LLM failed")
            yield  # make it an async generator

        executor.astream_events = astream_events
        adapter = LangChainAdapter(executor)

        await adapter.stream("hi", hooks, stream_options)

        hooks.on_error.assert_called_once()
        assert isinstance(hooks.on_error.call_args[0][0], RuntimeError)
        hooks.on_finish.assert_not_called()

    @pytest.mark.asyncio
    async def test_unknown_events_are_ignored(self, hooks, stream_options):
        events = [
            {"event": "on_llm_start", "data": {}, "name": ""},
            {"event": "on_chain_end", "data": {}, "name": ""},
            make_chunk_event("answer"),
        ]
        executor = make_executor_with_events(events)
        adapter = LangChainAdapter(executor)

        await adapter.stream("hi", hooks, stream_options)

        hooks.on_chunk.assert_called_once_with("answer")
        hooks.on_finish.assert_called_once()


class TestLangChainAdapterGetConfig:
    def test_returns_system_prompt_and_empty_tools(self):
        adapter = LangChainAdapter(MagicMock(), system_prompt="You are helpful.")
        config = adapter.get_config()
        assert config["system_prompt"] == "You are helpful."
        assert config["tools"] == []

    def test_returns_mapped_tools(self):
        tool = MagicMock()
        tool.name = "calculator"
        tool.description = "Does math"
        adapter = LangChainAdapter(MagicMock(), tools=[tool])
        config = adapter.get_config()
        assert len(config["tools"]) == 1
        assert config["tools"][0]["name"] == "calculator"
        assert config["tools"][0]["description"] == "Does math"
        assert config["tools"][0]["type"] == "other"
