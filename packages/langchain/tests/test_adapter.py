import pytest
from unittest.mock import MagicMock
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry import trace as otel_trace

from astropods_adapter_langchain import LangChainAdapter
from conftest import (
    make_executor_with_updates,
    make_model_update,
    make_msg,
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
    async def test_agent_node_name_calls_on_chunk(self, hooks, stream_options):
        """langgraph.prebuilt.create_react_agent emits 'agent' instead of 'model'."""
        executor = make_executor_with_updates([{"agent": {"messages": [make_msg("Hello from langgraph")]}}])
        adapter = LangChainAdapter(executor)

        await adapter.stream("hi", hooks, stream_options)

        hooks.on_chunk.assert_called_once_with("Hello from langgraph")
        hooks.on_finish.assert_called_once()

    @pytest.mark.asyncio
    async def test_agent_node_name_tool_call_sends_processing_status(self, hooks, stream_options):
        """Tool calls emitted under 'agent' node are handled correctly."""
        executor = make_executor_with_updates([{"agent": {"messages": [make_msg("", tool_calls=[{"name": "search_tool"}])]}}])
        adapter = LangChainAdapter(executor)

        await adapter.stream("hi", hooks, stream_options)

        hooks.on_status_update.assert_any_call({"status": "PROCESSING", "custom_message": "Running search_tool"})
        hooks.on_chunk.assert_not_called()

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



class TestLangChainAdapterSessionContext:
    @pytest.mark.asyncio
    async def test_astream_receives_thread_id_from_conversation_id(self, hooks, stream_options):
        executor = make_executor_with_updates([make_model_update("hi")])
        adapter = LangChainAdapter(executor)

        await adapter.stream("hello", hooks, stream_options)

        assert executor.last_astream_kwargs.get("config") == {
            "configurable": {"thread_id": "conv-123"}
        }

    @pytest.mark.asyncio
    async def test_span_sets_langfuse_user_and_session(self, hooks, stream_options):
        exporter = InMemorySpanExporter()
        provider = TracerProvider()
        provider.add_span_processor(SimpleSpanProcessor(exporter))

        import astropods_adapter_langchain.adapter as adapter_module
        original_tracer = adapter_module._tracer
        adapter_module._tracer = provider.get_tracer("test")

        try:
            executor = make_executor_with_updates([make_model_update("hi")])
            adapter = LangChainAdapter(executor)
            await adapter.stream("hello", hooks, stream_options)
        finally:
            adapter_module._tracer = original_tracer

        spans = exporter.get_finished_spans()
        assert len(spans) == 1
        assert spans[0].name == "LangChain Agent"
        attrs = spans[0].attributes
        assert attrs.get("langfuse.user.id") == "user-456"
        assert attrs.get("langfuse.session.id") == "conv-123"

class TestLangChainAdapterStreamAudio:
    @pytest.mark.asyncio
    async def test_no_voice_sends_error_message(self, hooks, stream_options):
        executor = MagicMock()
        adapter = LangChainAdapter(executor)

        from astropods_adapter_core.types import AudioInput
        audio_input = AudioInput(data=b"audio", config=MagicMock())

        await adapter.stream_audio(audio_input, hooks, stream_options)

        hooks.on_chunk.assert_called_once()
        assert "audio" in hooks.on_chunk.call_args[0][0].lower()
        hooks.on_finish.assert_called_once()
        hooks.on_error.assert_not_called()

    @pytest.mark.asyncio
    async def test_voice_transcribes_and_streams_text(self, hooks, stream_options):
        executor = make_executor_with_updates([make_model_update("Sure thing!")])

        class FakeVoice:
            async def listen(self, data, config):
                return "what time is it"

        adapter = LangChainAdapter(executor, voice=FakeVoice())
        from astropods_adapter_core.types import AudioInput
        audio_input = AudioInput(data=b"audio", config=MagicMock())

        await adapter.stream_audio(audio_input, hooks, stream_options)

        hooks.on_transcript.assert_called_once_with("what time is it")
        hooks.on_chunk.assert_called_once_with("Sure thing!")
        hooks.on_finish.assert_called_once()

    @pytest.mark.asyncio
    async def test_voice_with_speak_synthesizes_audio_after_text(self, hooks, stream_options):
        executor = make_executor_with_updates([make_model_update("It is noon.")])

        class FakeVoice:
            async def listen(self, data, config):
                return "what time is it"

            async def speak(self, text):
                yield b"audio-chunk-1"
                yield b"audio-chunk-2"

        adapter = LangChainAdapter(executor, voice=FakeVoice())
        from astropods_adapter_core.types import AudioInput
        audio_input = AudioInput(data=b"audio", config=MagicMock())

        await adapter.stream_audio(audio_input, hooks, stream_options)

        hooks.on_transcript.assert_called_once_with("what time is it")
        hooks.on_chunk.assert_called_once_with("It is noon.")
        hooks.on_audio_chunk.assert_any_call(b"audio-chunk-1")
        hooks.on_audio_chunk.assert_any_call(b"audio-chunk-2")
        hooks.on_audio_end.assert_called_once()
        hooks.on_finish.assert_called_once()

    @pytest.mark.asyncio
    async def test_listen_exception_calls_on_error(self, hooks, stream_options):
        class FailingVoice:
            async def listen(self, data, config):
                raise RuntimeError("STT failed")

        adapter = LangChainAdapter(MagicMock(), voice=FailingVoice())
        from astropods_adapter_core.types import AudioInput
        audio_input = AudioInput(data=b"audio", config=MagicMock())

        await adapter.stream_audio(audio_input, hooks, stream_options)

        hooks.on_error.assert_called_once()
        assert isinstance(hooks.on_error.call_args[0][0], RuntimeError)
        hooks.on_finish.assert_not_called()


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
