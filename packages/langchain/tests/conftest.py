import pytest
from unittest.mock import MagicMock
from astropods_adapter_core.types import StreamOptions


@pytest.fixture
def hooks():
    h = MagicMock()
    h.on_chunk = MagicMock()
    h.on_status_update = MagicMock()
    h.on_error = MagicMock()
    h.on_finish = MagicMock()
    h.on_transcript = MagicMock()
    h.on_audio_chunk = MagicMock()
    h.on_audio_end = MagicMock()
    return h


@pytest.fixture
def stream_options():
    return StreamOptions(conversation_id="conv-123", user_id="user-456")


def make_msg(content, tool_calls=None, name=None):
    msg = MagicMock()
    msg.content = content
    msg.tool_calls = tool_calls or []
    if name is not None:
        msg.name = name
    return msg


def make_model_update(content: str) -> dict:
    return {"model": {"messages": [make_msg(content)]}}


def make_tool_call_update(tool_name: str) -> dict:
    return {"model": {"messages": [make_msg("", tool_calls=[{"name": tool_name}])]}}


def make_tool_result_update(tool_name: str) -> dict:
    return {"tools": {"messages": [make_msg("result", name=tool_name)]}}


def make_executor_with_updates(updates: list):
    executor = MagicMock()
    executor.last_astream_kwargs = {}

    async def astream(*args, **kwargs):
        executor.last_astream_kwargs = kwargs
        for u in updates:
            yield u

    executor.astream = astream
    return executor
