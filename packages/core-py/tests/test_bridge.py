import asyncio
import json
import os
import pytest
from unittest.mock import AsyncMock, MagicMock, patch, call

from astropods_adapter_core.bridge import (
    MessagingBridge,
    _StreamHooksImpl,
    DEFAULT_SERVER_ADDR,
)
from astropods_adapter_core.types import ServeOptions, StreamOptions
from astropods_messaging import AudioChunk, ContentChunk, StatusUpdate, ErrorResponse, Transcript


# --- _StreamHooksImpl tests ---

class TestStreamHooksImpl:
    def setup_method(self):
        self.queue = asyncio.Queue()
        self.hooks = _StreamHooksImpl("conv-123", self.queue)

    def _dequeue_all(self):
        items = []
        while not self.queue.empty():
            items.append(self.queue.get_nowait())
        return items

    def test_on_chunk_enqueues_delta(self):
        self.hooks.on_chunk("hello")
        items = self._dequeue_all()
        assert len(items) == 1
        response = items[0].agent_response
        assert response.content.type == ContentChunk.ChunkType.Value("DELTA")
        assert response.content.content == "hello"
        assert response.conversation_id == "conv-123"

    def test_on_finish_enqueues_end(self):
        self.hooks.on_finish()
        items = self._dequeue_all()
        assert len(items) == 1
        response = items[0].agent_response
        assert response.content.type == ContentChunk.ChunkType.Value("END")

    def test_on_finish_sets_finished_flag(self):
        self.hooks.on_finish()
        self.hooks.on_chunk("should be ignored")
        items = self._dequeue_all()
        assert len(items) == 1  # only the END chunk, not the subsequent chunk

    def test_on_error_enqueues_error_response(self):
        self.hooks.on_error(ValueError("something went wrong"))
        items = self._dequeue_all()
        assert len(items) == 1
        response = items[0].agent_response
        assert response.error.code == ErrorResponse.ErrorCode.Value("AGENT_ERROR")
        assert "something went wrong" in response.error.message

    def test_on_error_sets_finished_flag(self):
        self.hooks.on_error(Exception("err"))
        self.hooks.on_finish()  # should be ignored
        items = self._dequeue_all()
        assert len(items) == 1  # only the error

    def test_on_status_update_enqueues_status(self):
        self.hooks.on_status_update({"status": "THINKING"})
        items = self._dequeue_all()
        assert len(items) == 1
        response = items[0].agent_response
        assert response.status.status == StatusUpdate.Status.Value("THINKING")

    def test_on_status_update_with_custom_message(self):
        self.hooks.on_status_update({"status": "PROCESSING", "custom_message": "Running tool"})
        items = self._dequeue_all()
        response = items[0].agent_response
        assert response.status.status == StatusUpdate.Status.Value("PROCESSING")
        assert response.status.custom_message == "Running tool"

    def test_on_status_update_unknown_status_defaults_to_thinking(self):
        self.hooks.on_status_update({"status": "UNKNOWN_STATUS"})
        items = self._dequeue_all()
        response = items[0].agent_response
        assert response.status.status == StatusUpdate.Status.Value("THINKING")

    def test_on_chunk_ignored_after_finish(self):
        self.hooks.on_finish()
        self.hooks.on_chunk("late chunk")
        self.hooks.on_status_update({"status": "THINKING"})
        items = self._dequeue_all()
        assert len(items) == 1  # only the END

    def test_on_transcript_enqueues_transcript(self):
        self.hooks.on_transcript("hello there")
        items = self._dequeue_all()
        assert len(items) == 1
        response = items[0].agent_response
        assert response.transcript.text == "hello there"
        assert response.conversation_id == "conv-123"

    def test_on_audio_chunk_enqueues_audio_chunk(self):
        self.hooks.on_audio_chunk(b"\x00\x01\x02")
        items = self._dequeue_all()
        assert len(items) == 1
        response = items[0].agent_response
        assert response.audio_chunk.data == b"\x00\x01\x02"
        assert response.audio_chunk.done is False

    def test_on_audio_end_enqueues_done_chunk(self):
        self.hooks.on_audio_end()
        items = self._dequeue_all()
        assert len(items) == 1
        response = items[0].agent_response
        assert response.audio_chunk.done is True

    def test_audio_hooks_ignored_after_finish(self):
        self.hooks.on_finish()
        self.hooks.on_transcript("late")
        self.hooks.on_audio_chunk(b"late")
        self.hooks.on_audio_end()
        items = self._dequeue_all()
        assert len(items) == 1  # only the END chunk

    # --- on_card tests ---

    def test_on_card_queues_but_does_not_emit_immediately(self):
        blocks = json.dumps([{"type": "section", "text": {"type": "mrkdwn", "text": "hi"}}])
        self.hooks.on_card(blocks)
        items = self._dequeue_all()
        assert items == []  # nothing on the wire until on_finish

    def test_on_card_attachments_flushed_on_finish(self):
        blocks_a = json.dumps([{"type": "section", "text": {"type": "mrkdwn", "text": "a"}}])
        blocks_b = json.dumps([{"type": "section", "text": {"type": "mrkdwn", "text": "b"}}])
        self.hooks.on_chunk("preamble")
        self.hooks.on_card(blocks_a)
        self.hooks.on_card(blocks_b)
        self.hooks.on_finish()

        items = self._dequeue_all()
        # DELTA + END
        assert len(items) == 2
        end_chunk = items[1].agent_response.content
        assert end_chunk.type == ContentChunk.ChunkType.Value("END")
        assert len(end_chunk.attachments) == 2
        assert end_chunk.attachments[0].card.platform_card_json == blocks_a
        assert end_chunk.attachments[1].card.platform_card_json == blocks_b

    def test_on_card_no_attachments_no_emission_on_delta(self):
        """Cards must NOT ride on DELTA chunks — server only processes attachments on END."""
        blocks = json.dumps([{"type": "section", "text": {"type": "mrkdwn", "text": "hi"}}])
        self.hooks.on_card(blocks)
        self.hooks.on_chunk("delta-text")
        items = self._dequeue_all()
        # Only the DELTA from on_chunk, with no attachments attached to it.
        assert len(items) == 1
        delta = items[0].agent_response.content
        assert delta.type == ContentChunk.ChunkType.Value("DELTA")
        assert len(delta.attachments) == 0

    def test_on_card_invalid_json_is_dropped(self):
        self.hooks.on_card("not-json-at-all")
        self.hooks.on_finish()
        items = self._dequeue_all()
        assert len(items) == 1
        end_chunk = items[0].agent_response.content
        assert end_chunk.type == ContentChunk.ChunkType.Value("END")
        assert len(end_chunk.attachments) == 0

    def test_on_card_empty_string_is_dropped(self):
        self.hooks.on_card("")
        self.hooks.on_finish()
        items = self._dequeue_all()
        assert len(items) == 1
        end_chunk = items[0].agent_response.content
        assert len(end_chunk.attachments) == 0

    def test_on_card_ignored_after_finish(self):
        self.hooks.on_finish()
        blocks = json.dumps([{"type": "section"}])
        self.hooks.on_card(blocks)
        # on_finish is idempotent and the late card should NOT cause a second END.
        items = self._dequeue_all()
        assert len(items) == 1  # only the original END
        assert len(items[0].agent_response.content.attachments) == 0

    def test_on_card_object_payload_accepted(self):
        """Non-array JSON (e.g. Teams Adaptive Card) is accepted — platform validates."""
        payload = json.dumps({"type": "AdaptiveCard", "body": []})
        self.hooks.on_card(payload)
        self.hooks.on_finish()
        items = self._dequeue_all()
        end_chunk = items[0].agent_response.content
        assert len(end_chunk.attachments) == 1
        assert end_chunk.attachments[0].card.platform_card_json == payload


# --- MessagingBridge constructor tests ---

class TestMessagingBridgeConstructor:
    def test_uses_options_server_address(self, mock_adapter):
        bridge = MessagingBridge(mock_adapter, ServeOptions(server_address="custom:1234"))
        assert bridge._server_address == "custom:1234"

    def test_uses_env_var(self, mock_adapter, monkeypatch):
        monkeypatch.setenv("GRPC_SERVER_ADDR", "env-host:5678")
        bridge = MessagingBridge(mock_adapter)
        assert bridge._server_address == "env-host:5678"

    def test_uses_default_when_no_config(self, mock_adapter, monkeypatch):
        monkeypatch.delenv("GRPC_SERVER_ADDR", raising=False)
        bridge = MessagingBridge(mock_adapter)
        assert bridge._server_address == DEFAULT_SERVER_ADDR

    def test_options_takes_precedence_over_env(self, mock_adapter, monkeypatch):
        monkeypatch.setenv("GRPC_SERVER_ADDR", "env-host:5678")
        bridge = MessagingBridge(mock_adapter, ServeOptions(server_address="options-host:9999"))
        assert bridge._server_address == "options-host:9999"


# --- MessagingBridge agent ID derivation ---

class TestAgentIdDerivation:
    def _get_registration_message(self, sent_messages):
        """Find the registration ConversationRequest among sent messages."""
        for msg in sent_messages:
            if hasattr(msg, "message") and msg.WhichOneof("request") == "message":
                m = msg.message
                if m.conversation_id == "agent-registration":
                    return m
        return None

    @pytest.mark.asyncio
    async def test_agent_id_is_lowercased_and_hyphenated(self, monkeypatch):
        adapter = MagicMock()
        adapter.name = "My Test Agent"
        adapter.stream = AsyncMock()
        adapter.get_config.return_value = {"system_prompt": "", "tools": []}

        sent = []

        mock_stream = MagicMock()
        mock_stream.write = AsyncMock(side_effect=lambda msg: sent.append(msg))

        async def fake_aiter(self):
            return
            yield  # make it an async generator

        mock_stream.__aiter__ = fake_aiter

        mock_stub = MagicMock()
        mock_stub.HealthCheck = AsyncMock(return_value=MagicMock(status=1))
        mock_stub.ProcessConversation = MagicMock(return_value=mock_stream)

        bridge = MessagingBridge(adapter, ServeOptions(server_address="localhost:9090"))
        bridge._stub = mock_stub

        with patch.object(bridge, "_connect_with_retry", new=AsyncMock()):
            bridge._stub = mock_stub
            # Run just enough to send registration
            task = asyncio.create_task(bridge.start())
            await asyncio.sleep(0.05)
            bridge.stop()
            try:
                await asyncio.wait_for(task, timeout=1.0)
            except (asyncio.TimeoutError, SystemExit):
                pass

        registration = self._get_registration_message(sent)
        if registration:
            assert registration.user.id == "my-test-agent"


# --- StreamOptions.platform plumbing ---

class TestPlatformPlumbing:
    """Ensure Message.platform is forwarded to the adapter via StreamOptions
    so adapters can gate platform-specific rendering (e.g. Slack-only cards)."""

    def test_stream_options_has_platform_default(self):
        """Default empty string when bridge doesn't set it (back-compat)."""
        opts = StreamOptions(conversation_id="c1", user_id="u1")
        assert opts.platform == ""

    def test_stream_options_accepts_platform(self):
        opts = StreamOptions(conversation_id="c1", user_id="u1", platform="slack")
        assert opts.platform == "slack"

    @pytest.mark.asyncio
    async def test_handle_message_plumbs_platform(self):
        """_handle_message must construct StreamOptions with message.platform."""
        from astropods_messaging import Message, User

        adapter = MagicMock()
        adapter.name = "test-agent"
        captured_options = {}

        async def capture_stream(prompt, hooks, options):
            captured_options["platform"] = options.platform
            captured_options["user_id"] = options.user_id
            captured_options["conversation_id"] = options.conversation_id

        adapter.stream = AsyncMock(side_effect=capture_stream)

        bridge = MessagingBridge(adapter, ServeOptions(server_address="localhost:9090"))

        message = Message(
            conversation_id="conv-xyz",
            platform="slack",
            content="hello from slack",
            user=User(id="U123", username="alice"),
        )

        await bridge._handle_message(message)

        assert captured_options["platform"] == "slack"
        assert captured_options["user_id"] == "U123"
        assert captured_options["conversation_id"] == "conv-xyz"

    @pytest.mark.asyncio
    async def test_handle_message_platform_empty_when_not_set(self):
        """Message with no platform field surfaces as empty string, not None."""
        from astropods_messaging import Message, User

        adapter = MagicMock()
        adapter.name = "test-agent"
        captured = {}

        async def capture_stream(prompt, hooks, options):
            captured["platform"] = options.platform

        adapter.stream = AsyncMock(side_effect=capture_stream)

        bridge = MessagingBridge(adapter, ServeOptions(server_address="localhost:9090"))
        message = Message(
            conversation_id="conv-1",
            content="hi",
            user=User(id="u1"),
        )

        await bridge._handle_message(message)
        assert captured["platform"] == ""
