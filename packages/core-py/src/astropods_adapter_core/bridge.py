from __future__ import annotations

import asyncio
import logging
import os
import signal
from typing import Optional

import grpc
import grpc.aio

from astropods_messaging import (
    AgentMessagingStub,
    AgentConfig,
    AgentToolConfig,
    AgentResponse,
    AudioChunk,
    AudioStreamConfig,
    ContentChunk,
    ConversationRequest,
    ErrorResponse,
    MessageReaction,
    HealthCheckRequest,
    Message,
    StatusUpdate,
    StreamControl,
    TraceContext,
    Transcript,
    User,
)

from .types import (
    AgentAdapter,
    AudioInput,
    FeedbackEvent,
    ServeOptions,
    StreamHooks,
    StreamOptions,
)

logger = logging.getLogger(__name__)

DEFAULT_SERVER_ADDR = "localhost:9090"
MAX_RETRIES = 10
INITIAL_DELAY_MS = 500
MAX_DELAY_MS = 15000

# StreamControl.Action value for a user "stop generating". Resolved once at
# import so the hot feedback path is a plain int comparison.
_STREAM_CONTROL_STOP = StreamControl.Action.Value("STOP")


def _debug(*args: object) -> None:
    if os.environ.get("DEBUG"):
        logger.debug(*args)


def _log_feedback_task_exception(task: "asyncio.Task[object]") -> None:
    """done_callback for scheduled async on_feedback tasks.

    Without this, an exception raised inside an async on_feedback would only
    surface as Python's noisy 'Task exception was never retrieved' warning
    at GC time. Reading the exception here both honours the documented
    'log and drop' contract and silences the warning.
    """
    if task.cancelled():
        return
    exc = task.exception()
    if exc is not None:
        logger.error(
            "async on_feedback raised; dropping event: %s", exc, exc_info=exc
        )


class _StreamHooksImpl:
    """Concrete StreamHooks that enqueues gRPC messages for the writer task."""

    def __init__(self, conversation_id: str, write_queue: asyncio.Queue) -> None:
        self._conversation_id = conversation_id
        self._write_queue = write_queue
        self._finished = False
        self._trace_context: Optional[TraceContext] = None

    def _enqueue(self, request: ConversationRequest) -> None:
        self._write_queue.put_nowait(request)

    def _response(self, **kwargs) -> AgentResponse:
        if self._trace_context is not None:
            kwargs.setdefault("trace_context", self._trace_context)
        return AgentResponse(conversation_id=self._conversation_id, **kwargs)

    def on_trace_context(self, trace_context: TraceContext) -> None:
        if not trace_context.traceparent:
            return
        self._trace_context = trace_context
        _debug("[bridge] Trace context attached: conversation=%s", self._conversation_id)

    def on_chunk(self, text: str) -> None:
        if self._finished:
            return
        chunk = ContentChunk(
            type=ContentChunk.ChunkType.Value("DELTA"),
            content=text,
        )
        response = self._response(content=chunk)
        self._enqueue(ConversationRequest(agent_response=response))

    def on_status_update(self, status: dict) -> None:
        if self._finished:
            return
        status_str = status.get("status", "THINKING")
        custom_message = status.get("custom_message", "")
        try:
            status_value = StatusUpdate.Status.Value(status_str)
        except ValueError:
            status_value = StatusUpdate.Status.Value("THINKING")
        update = StatusUpdate(status=status_value, custom_message=custom_message)
        response = self._response(status=update)
        self._enqueue(ConversationRequest(agent_response=response))

    def on_error(self, error: Exception) -> None:
        if self._finished:
            return
        self._finished = True
        err = ErrorResponse(
            code=ErrorResponse.ErrorCode.Value("AGENT_ERROR"),
            message=str(error),
        )
        response = self._response(error=err)
        self._enqueue(ConversationRequest(agent_response=response))
        logger.error("Agent error: %s", error)

    def on_finish(self) -> None:
        if self._finished:
            return
        self._finished = True
        chunk = ContentChunk(
            type=ContentChunk.ChunkType.Value("END"),
            content="",
        )
        response = self._response(content=chunk)
        self._enqueue(ConversationRequest(agent_response=response))
        _debug("[bridge] Response complete: conversation=%s", self._conversation_id)

    def on_transcript(self, text: str) -> None:
        if self._finished:
            return
        response = self._response(transcript=Transcript(text=text))
        self._enqueue(ConversationRequest(agent_response=response))

    def on_audio_chunk(self, data: bytes) -> None:
        if self._finished:
            return
        response = self._response(audio_chunk=AudioChunk(data=data, done=False))
        self._enqueue(ConversationRequest(agent_response=response))

    def on_audio_end(self) -> None:
        if self._finished:
            return
        response = self._response(audio_chunk=AudioChunk(done=True))
        self._enqueue(ConversationRequest(agent_response=response))


class MessagingBridge:
    """Connects an agent adapter to the Astro messaging service via gRPC."""

    def __init__(
        self, adapter: AgentAdapter, options: Optional[ServeOptions] = None
    ) -> None:
        self._adapter = adapter
        self._server_address: str = (
            (options.server_address if options else None)
            or os.environ.get("GRPC_SERVER_ADDR")
            or DEFAULT_SERVER_ADDR
        )
        self._channel: Optional[grpc.aio.Channel] = None
        self._stub: Optional[AgentMessagingStub] = None
        self._write_queue: asyncio.Queue = asyncio.Queue()
        self._stop_event: asyncio.Event = asyncio.Event()
        # In-flight turn task per conversation, so a StreamControl STOP (chat
        # "stop generating") can cancel the awaited model call.
        self._inflight: dict[str, asyncio.Task] = {}
        # Audio accumulation state: keyed by conversation_id
        self._audio_configs: dict = {}
        self._audio_chunks: dict = {}
        self._current_audio_conv_id: Optional[str] = None

    async def _connect_with_retry(self) -> None:
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                self._channel = grpc.aio.insecure_channel(self._server_address)
                self._stub = AgentMessagingStub(self._channel)
                response = await self._stub.HealthCheck(HealthCheckRequest())
                status_name = response.Status.Name(response.status)
                logger.info("Connected to messaging service (health: %s)", status_name)
                return
            except Exception as error:
                if self._channel:
                    await self._channel.close()
                    self._channel = None
                    self._stub = None
                if attempt == MAX_RETRIES:
                    raise
                delay_ms = min(INITIAL_DELAY_MS * (2 ** (attempt - 1)), MAX_DELAY_MS)
                logger.info(
                    "Waiting for messaging service (attempt %d/%d, retry in %dms)...",
                    attempt,
                    MAX_RETRIES,
                    delay_ms,
                )
                await asyncio.sleep(delay_ms / 1000)

    async def _writer_task(self, stream: grpc.aio.StreamStreamCall) -> None:
        """Consumes the write queue and sends messages to the gRPC stream sequentially."""
        while True:
            item = await self._write_queue.get()
            if item is None:
                break
            try:
                await stream.write(item)
            except Exception as e:
                logger.error("Stream write error: %s", e)

    async def start(self) -> None:
        agent_name = self._adapter.name
        agent_id = agent_name.lower().replace(" ", "-")

        logger.info("Starting %s...", agent_name)
        logger.info("  gRPC Server: %s", self._server_address)

        await self._connect_with_retry()

        stream = self._stub.ProcessConversation()

        # Start the sequential writer task
        writer = asyncio.create_task(self._writer_task(stream))

        # Send agent config for playground display
        config_dict = self._adapter.get_config()
        tool_configs = [
            AgentToolConfig(
                name=t.get("name", ""),
                title=t.get("name", ""),
                description=t.get("description", ""),
                type=t.get("type", "other"),
            )
            for t in config_dict.get("tools", [])
        ]
        agent_config = AgentConfig(
            system_prompt=config_dict.get("system_prompt", ""),
            tools=tool_configs,
        )
        await self._write_queue.put(ConversationRequest(agent_config=agent_config))
        logger.info("Agent config sent")

        # Register the agent
        registration = Message(
            conversation_id="agent-registration",
            platform="grpc",
            content="Agent ready",
            user=User(id=agent_id, username=agent_name),
        )
        await self._write_queue.put(ConversationRequest(message=registration))
        logger.info("%s is ready and listening for messages", agent_name)

        # Register signal handlers for graceful shutdown
        loop = asyncio.get_event_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, self.stop)

        # Read incoming messages from the server
        try:
            async for response in stream:
                payload = response.WhichOneof("payload")

                if payload == "audio_config":
                    config = response.audio_config
                    self._current_audio_conv_id = config.conversation_id
                    self._audio_configs[config.conversation_id] = config
                    self._audio_chunks[config.conversation_id] = []
                    continue

                if payload == "audio_chunk":
                    chunk = response.audio_chunk
                    if self._current_audio_conv_id:
                        if chunk.data:
                            self._audio_chunks[self._current_audio_conv_id].append(chunk.data)
                        if chunk.done:
                            conv_id = self._current_audio_conv_id
                            config = self._audio_configs.pop(conv_id, None)
                            chunks = self._audio_chunks.pop(conv_id, [])
                            self._current_audio_conv_id = None
                            if config and hasattr(self._adapter, "stream_audio"):
                                audio_input = AudioInput(
                                    data=b"".join(chunks),
                                    config=config,
                                )
                                self._track_turn(
                                    conv_id,
                                    self._handle_audio(conv_id, audio_input, config),
                                )
                    continue

                if payload == "feedback":
                    self._maybe_abort_on_stream_control(response.feedback)
                    self._dispatch_feedback(response.feedback)
                    continue

                if payload != "incoming_message":
                    continue

                message = response.incoming_message
                is_audio = (
                    message.content == "[audio]"
                    or any(
                        a.type == a.Type.Value("AUDIO")
                        for a in message.attachments
                    )
                )
                if is_audio and not hasattr(self._adapter, "stream_audio"):
                    hooks = _StreamHooksImpl(message.conversation_id, self._write_queue)
                    start_chunk = ContentChunk(
                        type=ContentChunk.ChunkType.Value("START"), content=""
                    )
                    await self._write_queue.put(
                        ConversationRequest(
                            agent_response=AgentResponse(
                                conversation_id=message.conversation_id,
                                content=start_chunk,
                            )
                        )
                    )
                    hooks.on_chunk(
                        "Sorry, I don't support audio input. Please send a text message."
                    )
                    hooks.on_finish()
                    continue

                if not is_audio:
                    self._track_turn(
                        message.conversation_id, self._handle_message(message)
                    )
        except grpc.aio.AioRpcError as e:
            if not self._stop_event.is_set():
                logger.error("Stream error: %s", e)
        finally:
            # Drain the writer
            await self._write_queue.put(None)
            await writer

        await self._stop_event.wait()

    def _dispatch_feedback(self, fb_proto) -> None:
        """Convert an incoming PlatformFeedback proto into a FeedbackEvent and
        hand it to the adapter's optional ``on_feedback`` callback.

        Skipped silently when the adapter doesn't implement ``on_feedback`` —
        feedback is informational and an agent that doesn't care shouldn't
        have to define a no-op stub.
        """
        on_feedback = getattr(self._adapter, "on_feedback", None)
        if on_feedback is None:
            return

        # WhichOneof("feedback") returns the snake_case proto field name of
        # the populated variant ("reaction", "text", "button_click",
        # "prompt_selection", "stream_control", "message_edit",
        # "message_delete"). The proto oneof is the source of truth for
        # the FeedbackEvent.kind discriminator — variants we don't unpack
        # specially fall through with kind = proto field name unchanged.
        kind = fb_proto.WhichOneof("feedback") or ""
        event_kind = kind
        text: Optional[str] = None
        prompt: Optional[str] = None
        if kind == "reaction":
            r = fb_proto.reaction
            # Map proto ReactionType enum → stable string kinds so adapters
            # can switch on .kind without importing protos themselves.
            if r.type == MessageReaction.THUMBS_UP:
                event_kind = "thumbs_up"
            elif r.type == MessageReaction.THUMBS_DOWN:
                event_kind = "thumbs_down"
            elif r.type == MessageReaction.CUSTOM_EMOJI:
                event_kind = "reaction"
                text = r.emoji
        elif kind == "text":
            text = fb_proto.text.text
            prompt = fb_proto.text.prompt

        event = FeedbackEvent(
            conversation_id=fb_proto.conversation_id,
            response_id=fb_proto.response_id,
            kind=event_kind,
            trace_context=(
                fb_proto.trace_context if fb_proto.HasField("trace_context") else None
            ),
            user_id=fb_proto.user.id,
            user_name=fb_proto.user.username,
            text=text,
            prompt=prompt,
        )

        try:
            result = on_feedback(event)
            # Tolerate both sync and async implementations — coroutines are
            # scheduled so on_feedback can do network IO (Airtable, queues)
            # without blocking the stream reader. Without the done_callback
            # below, async exceptions would only surface as Python's noisy
            # "Task exception was never retrieved" warning at GC time, which
            # contradicts the contract that exceptions are logged + dropped.
            if asyncio.iscoroutine(result):
                task = asyncio.create_task(result)
                task.add_done_callback(_log_feedback_task_exception)
        except Exception as exc:
            logger.exception("on_feedback raised; dropping event: %s", exc)

    def _maybe_abort_on_stream_control(self, fb_proto) -> None:
        """Cancel the in-flight turn when a StreamControl STOP feedback arrives.

        This is the chat "stop generating" path. With no cooperating runtime
        it's a best-effort task cancel; asyncio unwinds the awaited model call
        (CancelledError propagates out of ``adapter.stream``) so generation
        actually halts and only the partial is recorded. Non-STOP controls
        (pause/resume/regenerate) fall through to ``on_feedback`` untouched.
        """
        if fb_proto.WhichOneof("feedback") != "stream_control":
            return
        if fb_proto.stream_control.action != _STREAM_CONTROL_STOP:
            return
        self._abort_inflight(fb_proto.conversation_id)
        _debug(
            "[bridge] Stop received; aborting generation: conversation=%s",
            fb_proto.conversation_id,
        )

    def _abort_inflight(self, conversation_id: str) -> None:
        """Cancel and forget the in-flight turn task for a conversation, if any."""
        task = self._inflight.pop(conversation_id, None)
        if task is not None and not task.done():
            task.cancel()

    def _track_turn(self, conversation_id: str, coro) -> None:
        """Run a turn coroutine as a tracked task so a later STOP can cancel it.

        A new turn supersedes any prior in-flight turn on the same
        conversation, matching the platform's one-active-turn model.
        """
        # A new turn supersedes any prior in-flight turn on this conversation.
        self._abort_inflight(conversation_id)
        task = asyncio.create_task(coro)
        self._inflight[conversation_id] = task

        def _clear(finished: asyncio.Task) -> None:
            # Only clear if we're still the active turn — a newer turn may have
            # already replaced us in the map.
            if self._inflight.get(conversation_id) is finished:
                self._inflight.pop(conversation_id, None)

        task.add_done_callback(_clear)

    async def _handle_message(self, message: Message) -> None:
        conversation_id = message.conversation_id

        # Send START chunk before dispatching to adapter
        start_chunk = ContentChunk(
            type=ContentChunk.ChunkType.Value("START"), content=""
        )
        await self._write_queue.put(
            ConversationRequest(
                agent_response=AgentResponse(
                    conversation_id=conversation_id,
                    content=start_chunk,
                )
            )
        )

        hooks = _StreamHooksImpl(conversation_id, self._write_queue)
        options = StreamOptions(
            conversation_id=conversation_id,
            # `or` catches the empty-string case too — a user object with
            # id="" would otherwise leak through and classify as Unattributed.
            user_id=(message.user.id if message.user else "") or "anonymous",
            platform_context=(
                message.platform_context if message.HasField("platform_context") else None
            ),
        )

        try:
            await self._adapter.stream(message.content, hooks, options)
        except asyncio.CancelledError:
            # A user stop cancelled this turn. Finalization is owned by the
            # sidecar (it broadcasts the finish and closes the SSE), so end
            # quietly: no END chunk (the sidecar's stop-gate drops non-START
            # chunks on a stopped conversation) and no error surfaced.
            _debug(
                "[bridge] Generation aborted by stop: conversation=%s",
                conversation_id,
            )
        except Exception as error:
            hooks.on_error(
                error if isinstance(error, Exception) else Exception(str(error))
            )

    async def _handle_audio(
        self, conversation_id: str, audio_input: AudioInput, config: AudioStreamConfig
    ) -> None:
        start_chunk = ContentChunk(
            type=ContentChunk.ChunkType.Value("START"), content=""
        )
        await self._write_queue.put(
            ConversationRequest(
                agent_response=AgentResponse(
                    conversation_id=conversation_id,
                    content=start_chunk,
                )
            )
        )

        hooks = _StreamHooksImpl(conversation_id, self._write_queue)
        options = StreamOptions(
            conversation_id=conversation_id,
            user_id=config.user_id or "anonymous",
        )

        try:
            await self._adapter.stream_audio(audio_input, hooks, options)
        except asyncio.CancelledError:
            # A user stop cancelled this audio turn — end quietly (see
            # _handle_message; the sidecar owns finalization).
            _debug(
                "[bridge] Audio generation aborted by stop: conversation=%s",
                conversation_id,
            )
        except Exception as error:
            hooks.on_error(
                error if isinstance(error, Exception) else Exception(str(error))
            )

    def stop(self) -> None:
        logger.info("Shutting down...")
        self._stop_event.set()
        loop = asyncio.get_event_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.remove_signal_handler(sig)
            except Exception:
                pass
