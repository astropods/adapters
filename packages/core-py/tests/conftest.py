import pytest
from unittest.mock import AsyncMock, MagicMock
from astropods_adapter_core.types import StreamOptions


@pytest.fixture
def mock_adapter():
    adapter = MagicMock()
    adapter.name = "Test Agent"
    adapter.stream = AsyncMock()
    adapter.get_config.return_value = {"system_prompt": "You are a test agent.", "tools": []}
    return adapter


@pytest.fixture
def stream_options():
    return StreamOptions(conversation_id="conv-123", user_id="user-456")
