import asyncio
import os
import pytest
from unittest.mock import AsyncMock, MagicMock, patch, call

from astropods_adapter_core.bridge import (
    MessagingBridge,
    _StreamHooksImpl,
    DEFAULT_SERVER_ADDR,
)
from astropods_adapter_core.types import (
    FeedbackEvent,
    ServeOptions,
    StreamHooks,
    StreamOptions,
)
from astropods_messaging import (
    AudioChunk,
    ContentChunk,
    StatusUpdate,
    ErrorResponse,
    Message,
    PlatformContext,
    Transcript,
    MessageReaction,
    PlatformFeedback,
    StreamControl,
    TextFeedback,
    User,
)


class MinimalStreamHooks:
    def on_chunk(self, text: str) -> None:
        pass

    def on_status_update(self, status: dict) -> None:
        pass

    def on_error(self, error: Exception) -> None:
        pass

    def on_finish(self) -> None:
        pass

    def on_transcript(self, text: str) -> None:
        pass

    def on_audio_chunk(self, data: bytes) -> None:
        pass

    def on_audio_end(self) -> None:
        pass

    def on_file(self, name: str, mime_type=None, size=None) -> None:
        pass


def test_stream_hooks_does_not_require_trace_context_hook():
    assert isinstance(MinimalStreamHooks(), StreamHooks)


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


# --- Feedback dispatch ---

class TestFeedbackDispatch:
    def _make_bridge(self, adapter):
        return MessagingBridge(adapter, ServeOptions(server_address="localhost:9090"))

    def test_thumbs_up_maps_to_thumbs_up_kind(self):
        adapter = MagicMock()
        adapter.on_feedback = MagicMock()
        bridge = self._make_bridge(adapter)

        fb = PlatformFeedback(
            conversation_id="conv-1",
            response_id="msg-ts-1",
            user=User(id="U1", username="alice"),
            reaction=MessageReaction(type=MessageReaction.THUMBS_UP, added=True),
        )
        bridge._dispatch_feedback(fb)

        adapter.on_feedback.assert_called_once()
        event = adapter.on_feedback.call_args.args[0]
        assert isinstance(event, FeedbackEvent)
        assert event.kind == "thumbs_up"
        assert event.user_id == "U1"
        assert event.user_name == "alice"
        assert event.response_id == "msg-ts-1"

    def test_thumbs_down_maps_to_thumbs_down_kind(self):
        adapter = MagicMock()
        adapter.on_feedback = MagicMock()
        bridge = self._make_bridge(adapter)

        fb = PlatformFeedback(
            conversation_id="conv-1",
            reaction=MessageReaction(type=MessageReaction.THUMBS_DOWN, added=True),
        )
        bridge._dispatch_feedback(fb)
        event = adapter.on_feedback.call_args.args[0]
        assert event.kind == "thumbs_down"

    def test_text_feedback_surfaces_text_and_prompt(self):
        adapter = MagicMock()
        adapter.on_feedback = MagicMock()
        bridge = self._make_bridge(adapter)

        fb = PlatformFeedback(
            conversation_id="conv-1",
            text=TextFeedback(text="this was wrong", prompt="What did you think?"),
        )
        bridge._dispatch_feedback(fb)
        event = adapter.on_feedback.call_args.args[0]
        assert event.kind == "text"
        assert event.text == "this was wrong"
        assert event.prompt == "What did you think?"

    def test_no_on_feedback_method_is_silent_noop(self):
        # MagicMock auto-creates attributes — use a real class without the
        # method to verify the hasattr-gated skip path.
        class BareAdapter:
            name = "bare"

        bridge = self._make_bridge(BareAdapter())
        # Should not raise
        bridge._dispatch_feedback(PlatformFeedback(conversation_id="c"))

    def test_on_feedback_exception_is_swallowed(self):
        adapter = MagicMock()
        adapter.on_feedback = MagicMock(side_effect=RuntimeError("kaboom"))
        bridge = self._make_bridge(adapter)
        # Should not raise
        bridge._dispatch_feedback(
            PlatformFeedback(
                conversation_id="c",
                reaction=MessageReaction(type=MessageReaction.THUMBS_UP),
            )
        )
        adapter.on_feedback.assert_called_once()

    @pytest.mark.asyncio
    async def test_async_on_feedback_is_scheduled_and_runs(self):
        # Async callbacks must be scheduled and actually execute — otherwise
        # the docstring contract that "we tolerate sync and async" is a lie.
        ran = asyncio.Event()

        class A:
            name = "a"

            async def on_feedback(self, event):
                ran.set()

        bridge = self._make_bridge(A())
        bridge._dispatch_feedback(
            PlatformFeedback(
                conversation_id="c",
                reaction=MessageReaction(type=MessageReaction.THUMBS_UP),
            )
        )
        # The async body runs on the next loop tick; bounded wait so a
        # bug that drops the task surfaces as a timeout rather than a hang.
        await asyncio.wait_for(ran.wait(), timeout=1.0)

    @pytest.mark.asyncio
    async def test_async_on_feedback_exception_is_logged(self, caplog):
        # Regression guard for the High-severity reviewer finding: an async
        # on_feedback that raises must hit the done_callback path and emit
        # a structured log, NOT a noisy "Task exception was never retrieved"
        # warning at GC time.
        class A:
            name = "a"

            async def on_feedback(self, event):
                raise RuntimeError("async kaboom")

        bridge = self._make_bridge(A())
        caplog.set_level("ERROR", logger="astropods_adapter_core.bridge")
        bridge._dispatch_feedback(
            PlatformFeedback(
                conversation_id="c",
                reaction=MessageReaction(type=MessageReaction.THUMBS_UP),
            )
        )
        # Let the scheduled task run to completion + done_callback fire.
        await asyncio.sleep(0.05)
        assert any("async on_feedback raised" in rec.message for rec in caplog.records), (
            "expected done_callback to log the exception; got: "
            + repr([r.message for r in caplog.records])
        )


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


# --- MessagingBridge platform_context forwarding ---

class TestPlatformContextForwarding:
    """_handle_message must surface platform_context onto StreamOptions so
    adapter authors can branch on channel/thread/event_kind without
    importing the messaging proto themselves."""

    def _make_bridge(self, adapter):
        bridge = MessagingBridge(adapter, ServeOptions(server_address="localhost:9090"))
        # _handle_message awaits self._write_queue.put for the START chunk;
        # the queue is created in __init__ so no extra setup is needed.
        return bridge

    @pytest.mark.asyncio
    async def test_forwards_platform_context_when_set(self):
        captured: list[StreamOptions] = []

        async def stream(prompt, hooks, options):
            captured.append(options)

        adapter = MagicMock()
        adapter.stream = stream

        bridge = self._make_bridge(adapter)

        pc = PlatformContext(
            message_id="1700000000.000100",
            channel_id="C42",
            thread_id="1699999999.000001",
            workspace_id="T9",
            bot_user_id="UBOT",
            event_kind=PlatformContext.EVENT_KIND_APP_MENTION,
            user_id="U123",
        )
        msg = Message(
            conversation_id="conv-77",
            content="hi",
            platform="slack",
            user=User(id="U123", username="Ada"),
            platform_context=pc,
        )

        await bridge._handle_message(msg)

        assert len(captured) == 1
        opts = captured[0]
        assert opts.conversation_id == "conv-77"
        assert opts.user_id == "U123"
        assert opts.platform_context is not None
        assert opts.platform_context.channel_id == "C42"
        assert opts.platform_context.thread_id == "1699999999.000001"
        assert opts.platform_context.workspace_id == "T9"
        assert opts.platform_context.bot_user_id == "UBOT"
        assert opts.platform_context.event_kind == PlatformContext.EVENT_KIND_APP_MENTION

    @pytest.mark.asyncio
    async def test_platform_context_is_none_when_unset(self):
        """A message with no platform_context (e.g. from the playground or
        a direct gRPC client) must surface as None, not an empty proto —
        adapters should be able to write `if opts.platform_context:`."""
        captured: list[StreamOptions] = []

        async def stream(prompt, hooks, options):
            captured.append(options)

        adapter = MagicMock()
        adapter.stream = stream

        bridge = self._make_bridge(adapter)

        msg = Message(
            conversation_id="conv-78",
            content="hi",
            platform="grpc",
            user=User(id="U1", username="Ada"),
        )

        await bridge._handle_message(msg)

        assert len(captured) == 1
        assert captured[0].platform_context is None


# --- Stop generation (StreamControl STOP) ---


class _RecordingAdapter:
    """Adapter whose stream() emits a partial chunk then blocks until released.

    Each call records its own lifecycle so tests can assert on *observable*
    outcomes — was the awaited call actually interrupted? did it run to
    completion? — rather than on mock call bookkeeping (which would pass no
    matter what the bridge does).
    """

    def __init__(self) -> None:
        self.name = "recording"
        self.calls: list[dict] = []

    async def stream(self, prompt, hooks, options) -> None:
        state = {
            "conversation_id": options.conversation_id,
            "prompt": prompt,
            "started": asyncio.Event(),
            "release": asyncio.Event(),
            "cancelled": False,
            "completed": False,
        }
        self.calls.append(state)
        hooks.on_chunk("partial ")
        state["started"].set()
        try:
            await state["release"].wait()
        except asyncio.CancelledError:
            state["cancelled"] = True
            raise
        hooks.on_chunk("done")
        hooks.on_finish()
        state["completed"] = True

    def get_config(self) -> dict:
        return {"system_prompt": "", "tools": []}


def _drain(queue: asyncio.Queue) -> list:
    items = []
    while not queue.empty():
        items.append(queue.get_nowait())
    return items


def _content_events(items: list) -> list:
    """Reduce queued requests to [(kind, text)] for the agent-response chunks.

    kind is 'start' / 'delta' / 'end' for content chunks, or 'error'.
    """
    events = []
    for it in items:
        if not it.HasField("agent_response"):
            continue
        ar = it.agent_response
        if ar.HasField("error"):
            events.append(("error", ar.error.message))
        elif ar.HasField("content"):
            kind = ContentChunk.ChunkType.Name(ar.content.type).lower()
            events.append((kind, ar.content.content))
    return events


async def _await_started(
    adapter: _RecordingAdapter,
    conversation_id: str,
    prompt: str | None = None,
    timeout: float = 1.0,
) -> dict:
    """Block until the matching turn has entered stream().

    ``prompt`` disambiguates successive turns on the same conversation (the
    supersede case), where filtering by ``conversation_id`` alone would match
    the already-started prior call.
    """

    async def _wait() -> dict:
        while True:
            match = next(
                (
                    c
                    for c in reversed(adapter.calls)
                    if c["conversation_id"] == conversation_id
                    and (prompt is None or c["prompt"] == prompt)
                ),
                None,
            )
            if match is not None:
                await match["started"].wait()
                return match
            await asyncio.sleep(0)

    return await asyncio.wait_for(_wait(), timeout)


def _stop_feedback(conversation_id: str) -> PlatformFeedback:
    return PlatformFeedback(
        conversation_id=conversation_id,
        stream_control=StreamControl(action=StreamControl.STOP),
    )


async def _settle(predicate, timeout: float = 1.0) -> None:
    """Yield until ``predicate`` holds or the timeout elapses.

    Deliberately does NOT cancel any task — unlike ``asyncio.wait_for``, which
    cancels its awaitable on timeout and would itself trigger the code path
    under test, making the stop assertions pass whether or not the bridge
    actually cancelled anything.
    """
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.005)


class TestStopGeneration:
    def _bridge(self, adapter: _RecordingAdapter) -> MessagingBridge:
        return MessagingBridge(adapter, ServeOptions(server_address="localhost:9090"))

    def _start_turn(self, bridge: MessagingBridge, conversation_id: str, content: str = "hi") -> "asyncio.Task":
        msg = Message(conversation_id=conversation_id, content=content, user=User(id="u1"))
        bridge._track_turn(conversation_id, bridge._handle_message(msg))
        return bridge._inflight[conversation_id]

    @pytest.mark.asyncio
    async def test_stop_cancels_generation_and_does_not_finalize(self):
        adapter = _RecordingAdapter()
        bridge = self._bridge(adapter)

        task = self._start_turn(bridge, "c1")
        call = await _await_started(adapter, "c1")
        assert "c1" in bridge._inflight

        bridge._maybe_abort_on_stream_control(_stop_feedback("c1"))
        # Only the bridge's STOP handling can drive this turn to completion —
        # _settle never cancels the task itself, so if the STOP were a no-op the
        # task would stay pending and the assertions below would fail.
        await _settle(lambda: task.done())
        await asyncio.sleep(0)  # let the done-callback clear _inflight

        # The awaited model call was actually interrupted, not run to completion.
        assert task.done()
        assert call["cancelled"] is True
        assert call["completed"] is False

        # The partial reaches the client, but the turn is never finalized by the
        # agent (no END, no error) — the sidecar owns stop finalization.
        events = _content_events(_drain(bridge._write_queue))
        assert ("start", "") in events
        assert ("delta", "partial ") in events
        assert not any(kind == "end" for kind, _ in events)
        assert not any(kind == "error" for kind, _ in events)

        assert "c1" not in bridge._inflight

    @pytest.mark.asyncio
    async def test_non_stop_feedback_does_not_cancel(self):
        adapter = _RecordingAdapter()
        bridge = self._bridge(adapter)

        task = self._start_turn(bridge, "c1")
        call = await _await_started(adapter, "c1")

        # A thumbs-up reaction must leave the in-flight turn untouched.
        bridge._maybe_abort_on_stream_control(
            PlatformFeedback(
                conversation_id="c1",
                reaction=MessageReaction(type=MessageReaction.THUMBS_UP),
            )
        )
        # Give any (erroneous) cancellation time to land before asserting it did not.
        await asyncio.sleep(0.02)
        assert call["cancelled"] is False
        assert task.done() is False
        assert "c1" in bridge._inflight

        # Released, the turn finishes normally and finalizes with an END.
        call["release"].set()
        await asyncio.wait_for(task, timeout=1.0)
        assert call["completed"] is True
        assert ("end", "") in _content_events(_drain(bridge._write_queue))

    @pytest.mark.asyncio
    async def test_new_turn_supersedes_prior_turn(self):
        adapter = _RecordingAdapter()
        bridge = self._bridge(adapter)

        first = self._start_turn(bridge, "c1", content="first")
        first_call = await _await_started(adapter, "c1", prompt="first")

        # Second message on the same conversation supersedes the first.
        second = self._start_turn(bridge, "c1", content="second")
        second_call = await _await_started(adapter, "c1", prompt="second")

        # Starting the second turn — not any test-side wait — must cancel the first.
        await _settle(lambda: first.done())
        await asyncio.sleep(0)

        assert first.done()
        assert first_call["cancelled"] is True
        assert first_call["completed"] is False
        assert second_call["cancelled"] is False
        assert bridge._inflight.get("c1") is second

        second_call["release"].set()
        await asyncio.wait_for(second, timeout=1.0)
        assert second_call["completed"] is True

    @pytest.mark.asyncio
    async def test_stop_is_scoped_to_its_conversation(self):
        adapter = _RecordingAdapter()
        bridge = self._bridge(adapter)

        task1 = self._start_turn(bridge, "c1")
        task2 = self._start_turn(bridge, "c2")
        call1 = await _await_started(adapter, "c1")
        call2 = await _await_started(adapter, "c2")

        bridge._maybe_abort_on_stream_control(_stop_feedback("c1"))
        await _settle(lambda: task1.done())
        await asyncio.sleep(0)

        # Only c1 is cancelled; c2 keeps generating and stays tracked.
        assert task1.done()
        assert call1["cancelled"] is True
        assert call2["cancelled"] is False
        assert task2.done() is False
        assert "c1" not in bridge._inflight
        assert bridge._inflight.get("c2") is task2

        call2["release"].set()
        await asyncio.wait_for(task2, timeout=1.0)
        assert call2["completed"] is True

    @pytest.mark.asyncio
    async def test_stop_for_unknown_conversation_is_noop(self):
        adapter = _RecordingAdapter()
        bridge = self._bridge(adapter)
        # No in-flight turn: must not raise and must not fabricate state.
        bridge._maybe_abort_on_stream_control(_stop_feedback("ghost"))
        assert bridge._inflight == {}
