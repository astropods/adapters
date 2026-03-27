from __future__ import annotations

import logging
import os
from typing import Any, Optional

from langchain_core.messages import HumanMessage
from opentelemetry import trace as otel_trace

from astropods_adapter_core.types import AudioInput, StreamHooks, StreamOptions, VoiceProvider

_tracer = otel_trace.get_tracer(__name__)

logger = logging.getLogger(__name__)


def _debug(*args: object) -> None:
    if os.environ.get("DEBUG"):
        logger.debug(*args)


def _text_from_content(content: Any) -> str:
    """Extract plain text from a LangChain message content field.

    Handles both string content (OpenAI-style) and list content blocks
    (Anthropic-style: [{"type": "text", "text": "..."}]).
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            block.get("text", "")
            for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        )
    return ""


class LangChainAdapter:
    """Adapts a LangGraph create_agent executor to the Astro messaging protocol.

    Uses astream(stream_mode="updates") to receive state updates from the graph.
    The "model" update contains the AI response; the "tools" update contains
    tool results. Note: responses arrive as complete messages (not token-by-token)
    because create_agent uses ainvoke internally with trace=False.
    """

    def __init__(
        self,
        executor: Any,
        name: str = "LangChain Agent",
        system_prompt: str = "",
        tools: Optional[list] = None,
        voice: Optional[VoiceProvider] = None,
    ) -> None:
        self.name = name
        self._executor = executor
        self._system_prompt = system_prompt
        self._tools = tools or []
        self._voice = voice

    async def stream(
        self, prompt: str, hooks: StreamHooks, options: StreamOptions
    ) -> None:
        with _tracer.start_as_current_span(self.name) as span:
            span.set_attribute("langfuse.user.id", options.user_id)
            span.set_attribute("langfuse.session.id", options.conversation_id)
            await self._stream(prompt, hooks, options)

    async def _stream(
        self, prompt: str, hooks: StreamHooks, options: StreamOptions
    ) -> None:
        try:
            async for chunk in self._executor.astream(
                {"messages": [HumanMessage(content=prompt)]},
                config={"configurable": {"thread_id": options.conversation_id}},
                stream_mode="updates",
            ):
                if "model" in chunk:
                    for msg in chunk["model"].get("messages", []):
                        tool_calls = getattr(msg, "tool_calls", None) or []
                        if tool_calls:
                            for tc in tool_calls:
                                tool_name = tc.get("name", "tool") if isinstance(tc, dict) else getattr(tc, "name", "tool")
                                _debug("[LangChainAdapter] tool call: %s", tool_name)
                                hooks.on_status_update({
                                    "status": "PROCESSING",
                                    "custom_message": f"Running {tool_name}",
                                })
                        else:
                            text = _text_from_content(msg.content)
                            if text:
                                hooks.on_chunk(text)

                elif "tools" in chunk:
                    for msg in chunk["tools"].get("messages", []):
                        tool_name = getattr(msg, "name", "tool")
                        _debug("[LangChainAdapter] tool result: %s", tool_name)
                        hooks.on_status_update({
                            "status": "ANALYZING",
                            "custom_message": f"Finished {tool_name}",
                        })

            hooks.on_finish()

        except Exception as e:
            hooks.on_error(e)

    async def stream_audio(
        self, audio_input: AudioInput, hooks: StreamHooks, options: StreamOptions
    ) -> None:
        """Handle an audio request: STT → agent → optional TTS.

        Requires voice to be set on the adapter. If voice is not configured,
        falls back to a text error response. If the voice provider implements
        speak(), the agent's text response is synthesized to audio after streaming.
        """
        if self._voice is None:
            hooks.on_chunk("Sorry, I don't support audio input. Please send a text message.")
            hooks.on_finish()
            return

        try:
            transcript = await self._voice.listen(audio_input.data, audio_input.config)
            hooks.on_transcript(transcript)

            has_tts = hasattr(self._voice, "speak") and callable(getattr(self._voice, "speak"))

            if not has_tts:
                await self.stream(transcript, hooks, options)
                return

            # With TTS: accumulate text while streaming, then synthesize audio.
            text_chunks: list[str] = []
            error_occurred = False

            class _AccumulatingHooks:
                def on_chunk(self_, text: str) -> None:
                    text_chunks.append(text)
                    hooks.on_chunk(text)

                def on_status_update(self_, status: dict) -> None:
                    hooks.on_status_update(status)

                def on_error(self_, error: Exception) -> None:
                    nonlocal error_occurred
                    error_occurred = True
                    hooks.on_error(error)

                def on_finish(self_) -> None:
                    pass  # deferred until after TTS

                def on_transcript(self_, text: str) -> None:
                    hooks.on_transcript(text)

                def on_audio_chunk(self_, data: bytes) -> None:
                    hooks.on_audio_chunk(data)

                def on_audio_end(self_) -> None:
                    hooks.on_audio_end()

            await self.stream(transcript, _AccumulatingHooks(), options)

            if error_occurred:
                return

            full_text = "".join(text_chunks)
            async for audio_chunk in self._voice.speak(full_text):  # type: ignore[attr-defined]
                hooks.on_audio_chunk(audio_chunk)
            hooks.on_audio_end()
            hooks.on_finish()

        except Exception as e:
            hooks.on_error(e)

    def get_config(self) -> dict:
        tool_configs = [
            {
                "name": getattr(t, "name", str(t)),
                "title": getattr(t, "name", str(t)),
                "description": getattr(t, "description", ""),
                "type": "other",
            }
            for t in self._tools
        ]
        return {
            "system_prompt": self._system_prompt,
            "tools": tool_configs,
        }
