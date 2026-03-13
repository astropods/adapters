from __future__ import annotations
from dataclasses import dataclass
from typing import Optional, Protocol, runtime_checkable


@runtime_checkable
class StreamHooks(Protocol):
    """Lifecycle callbacks called by an adapter as the agent streams a response."""

    def on_chunk(self, text: str) -> None:
        """Send a text token or fragment from the LLM."""
        ...

    def on_status_update(self, status: dict) -> None:
        """Send an agent state change. status must contain a 'status' key with one of:
        THINKING, SEARCHING, GENERATING, PROCESSING, ANALYZING, CUSTOM.
        Optionally include 'custom_message' for CUSTOM status.
        """
        ...

    def on_error(self, error: Exception) -> None:
        """Signal that an error occurred during generation."""
        ...

    def on_finish(self) -> None:
        """Signal that the response is complete. Must be called exactly once per request.
        Must not be called if on_error has already been called for the same request.
        """
        ...

    def on_transcript(self, text: str) -> None:
        """Send the transcribed text of the user's audio input."""
        ...

    def on_audio_chunk(self, data: bytes) -> None:
        """Send a chunk of TTS audio back to the client."""
        ...

    def on_audio_end(self) -> None:
        """Signal the end of the current audio response segment."""
        ...


@dataclass
class StreamOptions:
    """Per-request context passed to the adapter's stream method."""

    conversation_id: str
    user_id: str


@dataclass
class ServeOptions:
    """Options for the serve() entry point and MessagingBridge."""

    server_address: Optional[str] = None


@runtime_checkable
class AgentAdapter(Protocol):
    """Framework-agnostic interface that any agent adapter must implement."""

    name: str

    async def stream(
        self, prompt: str, hooks: StreamHooks, options: StreamOptions
    ) -> None:
        """Stream a response for the given prompt, invoking hooks as the agent progresses."""
        ...

    def get_config(self) -> dict:
        """Return agent metadata for playground display (system prompt, tool list)."""
        ...
