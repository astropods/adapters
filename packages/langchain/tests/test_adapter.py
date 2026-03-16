import pytest
from unittest.mock import MagicMock

from astropods_adapter_langchain import LangChainAdapter
from conftest import (
    make_executor_with_updates,
    make_model_update,
    make_tool_call_update,
    make_tool_result_update,
)


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
    async def test_model_update_calls_on_chunk(self, hooks, stream_options):
        executor = make_executor_with_updates([make_model_update("Hello world")])
        adapter = LangChainAdapter(executor)

        await adapter.stream("hi", hooks, stream_options)

        hooks.on_chunk.assert_called_once_with("Hello world")
        hooks.on_finish.assert_called_once()

    @pytest.mark.asyncio
    async def test_empty_content_is_skipped(self, hooks, stream_options):
        executor = make_executor_with_updates([make_model_update("")])
        adapter = LangChainAdapter(executor)

        await adapter.stream("hi", hooks, stream_options)

        hooks.on_chunk.assert_not_called()
        hooks.on_finish.assert_called_once()

    @pytest.mark.asyncio
    async def test_list_content_extracts_text_blocks(self, hooks, stream_options):
        from unittest.mock import MagicMock
        msg = MagicMock()
        msg.content = [{"type": "text", "text": "Hello"}, {"type": "text", "text": " world"}]
        msg.tool_calls = []
        executor = make_executor_with_updates([{"model": {"messages": [msg]}}])
        adapter = LangChainAdapter(executor)

        await adapter.stream("hi", hooks, stream_options)

        hooks.on_chunk.assert_called_once_with("Hello world")

    @pytest.mark.asyncio
    async def test_list_content_skips_non_text_blocks(self, hooks, stream_options):
        msg = MagicMock()
        msg.content = [{"type": "tool_use", "id": "123"}, {"type": "text", "text": "answer"}]
        msg.tool_calls = []
        executor = make_executor_with_updates([{"model": {"messages": [msg]}}])
        adapter = LangChainAdapter(executor)

        await adapter.stream("hi", hooks, stream_options)

        hooks.on_chunk.assert_called_once_with("answer")

    @pytest.mark.asyncio
    async def test_tool_call_sends_processing_status(self, hooks, stream_options):
        executor = make_executor_with_updates([make_tool_call_update("search_tool")])
        adapter = LangChainAdapter(executor)

        await adapter.stream("hi", hooks, stream_options)

        hooks.on_status_update.assert_any_call({
            "status": "PROCESSING",
            "custom_message": "Running search_tool",
        })
        hooks.on_chunk.assert_not_called()

    @pytest.mark.asyncio
    async def test_tool_result_sends_analyzing_status(self, hooks, stream_options):
        executor = make_executor_with_updates([make_tool_result_update("search_tool")])
        adapter = LangChainAdapter(executor)

        await adapter.stream("hi", hooks, stream_options)

        hooks.on_status_update.assert_any_call({
            "status": "ANALYZING",
            "custom_message": "Finished search_tool",
        })

    @pytest.mark.asyncio
    async def test_full_tool_use_cycle(self, hooks, stream_options):
        updates = [
            make_tool_call_update("calculator"),
            make_tool_result_update("calculator"),
            make_model_update("The answer is 42"),
        ]
        executor = make_executor_with_updates(updates)
        adapter = LangChainAdapter(executor)

        await adapter.stream("hi", hooks, stream_options)

        hooks.on_status_update.assert_any_call({"status": "PROCESSING", "custom_message": "Running calculator"})
        hooks.on_status_update.assert_any_call({"status": "ANALYZING", "custom_message": "Finished calculator"})
        hooks.on_chunk.assert_called_once_with("The answer is 42")
        hooks.on_finish.assert_called_once()

    @pytest.mark.asyncio
    async def test_on_finish_called_after_stream(self, hooks, stream_options):
        executor = make_executor_with_updates([make_model_update("response")])
        adapter = LangChainAdapter(executor)

        await adapter.stream("hi", hooks, stream_options)

        hooks.on_finish.assert_called_once()

    @pytest.mark.asyncio
    async def test_exception_calls_on_error_not_on_finish(self, hooks, stream_options):
        executor = MagicMock()

        async def astream(*args, **kwargs):
            raise RuntimeError("LLM failed")
            yield  # make it an async generator

        executor.astream = astream
        adapter = LangChainAdapter(executor)

        await adapter.stream("hi", hooks, stream_options)

        hooks.on_error.assert_called_once()
        assert isinstance(hooks.on_error.call_args[0][0], RuntimeError)
        hooks.on_finish.assert_not_called()

    @pytest.mark.asyncio
    async def test_unknown_keys_are_ignored(self, hooks, stream_options):
        updates = [
            {"__start__": {"messages": []}},
            make_model_update("answer"),
        ]
        executor = make_executor_with_updates(updates)
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
