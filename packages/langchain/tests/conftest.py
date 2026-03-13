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


def make_event(kind: str, **data) -> dict:
    return {"event": kind, "data": data, "name": data.pop("name", "")}


def make_executor_with_events(events: list):
    executor = MagicMock()

    async def astream_events(*args, **kwargs):
        for e in events:
            yield e

    executor.astream_events = astream_events
    return executor
