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
    HealthCheckRequest,
    Message,
    StatusUpdate,
    Transcript,
    User,
)

from .types import AgentAdapter, AudioInput, ServeOptions, StreamHooks, StreamOptions

logger = logging.getLogger(__name__)

DEFAULT_SERVER_ADDR = "localhost:9090"
MAX_RETRIES = 10
INITIAL_DELAY_MS = 500
MAX_DELAY_MS = 15000


def _debug(*args: object) -> None:
    if os.environ.get("DEBUG"):
        logger.debug(*args)


class _StreamHooksImpl:
    """Concrete StreamHooks that enqueues gRPC messages for the writer task."""

    def __init__(self, conversation_id: str, write_queue: asyncio.Queue) -> None:
        self._conversation_id = conversation_id
        self._write_queue = write_queue
        self._finished = False

    def _enqueue(self, request: ConversationRequest) -> None:
        self._write_queue.put_nowait(request)

    def on_chunk(self, text: str) -> None:
        if self._finished:
            return
        chunk = ContentChunk(
            type=ContentChunk.ChunkType.Value("DELTA"),
            content=text,
        )
        response = AgentResponse(
            conversation_id=self._conversation_id,
            content=chunk,
        )
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
        response = AgentResponse(
            conversation_id=self._conversation_id,
            status=update,
        )
        self._enqueue(ConversationRequest(agent_response=response))

    def on_error(self, error: Exception) -> None:
        if self._finished:
            return
        self._finished = True
        err = ErrorResponse(
            code=ErrorResponse.ErrorCode.Value("AGENT_ERROR"),
            message=str(error),
        )
        response = AgentResponse(
            conversation_id=self._conversation_id,
            error=err,
        )
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
        response = AgentResponse(
            conversation_id=self._conversation_id,
            content=chunk,
        )
        self._enqueue(ConversationRequest(agent_response=response))
        _debug("[bridge] Response complete: conversation=%s", self._conversation_id)

    def on_transcript(self, text: str) -> None:
        if self._finished:
            return
        response = AgentResponse(
            conversation_id=self._conversation_id,
            transcript=Transcript(text=text),
        )
        self._enqueue(ConversationRequest(agent_response=response))

    def on_audio_chunk(self, data: bytes) -> None:
        if self._finished:
            return
        response = AgentResponse(
            conversation_id=self._conversation_id,
            audio_chunk=AudioChunk(data=data, done=False),
        )
        self._enqueue(ConversationRequest(agent_response=response))

    def on_audio_end(self) -> None:
        if self._finished:
            return
        response = AgentResponse(
            conversation_id=self._conversation_id,
            audio_chunk=AudioChunk(done=True),
        )
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
                                asyncio.create_task(
                                    self._handle_audio(conv_id, audio_input, config)
                                )
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
                    asyncio.create_task(self._handle_message(message))
        except grpc.aio.AioRpcError as e:
            if not self._stop_event.is_set():
                logger.error("Stream error: %s", e)
        finally:
            # Drain the writer
            await self._write_queue.put(None)
            await writer

        await self._stop_event.wait()

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
            user_id=message.user.id if message.user else "anonymous",
        )

        try:
            await self._adapter.stream(message.content, hooks, options)
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
