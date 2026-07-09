from __future__ import annotations
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Optional, Protocol, runtime_checkable

if TYPE_CHECKING:
    from astropods_messaging import PlatformContext, TraceContext


@runtime_checkable
class StreamHooks(Protocol):
    """Lifecycle callbacks called by an adapter as the agent streams a response."""

    def on_trace_context(self, trace_context: "TraceContext") -> None:
        """W3C trace context for this assistant turn."""
        ...

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


@runtime_checkable
class VoiceProvider(Protocol):
    """Interface for a voice provider that handles STT and optionally TTS.

    Implement ``listen`` to transcribe audio. Optionally implement ``speak``
    to synthesize audio responses.
    """

    async def listen(self, data: bytes, config: Any) -> str:
        """Transcribe raw audio bytes to text."""
        ...


@dataclass
class AudioInput:
    """Audio data and configuration passed to an adapter's stream_audio method."""

    data: bytes
    config: Any  # AudioStreamConfig proto from astropods_messaging


@dataclass
class StreamOptions:
    """Per-request context passed to the adapter's stream method."""

    conversation_id: str
    user_id: str
    # Platform-specific context from the source event (channel/thread IDs,
    # workspace, event_kind, raw platform user_id, etc.). None when the
    # message did not originate from a platform adapter (e.g. playground
    # or direct gRPC). See PlatformContext in astropods_messaging.
    platform_context: Optional["PlatformContext"] = None


@dataclass
class FeedbackEvent:
    """Inbound feedback from the platform (thumbs up/down, free-form comment, etc.).

    Passed to ``AgentAdapter.on_feedback`` when the user interacts with a
    feedback affordance the adapter renders alongside an agent reply.

    ``kind`` is a stable string identifier so adapters don't need to import
    proto types to switch on it. Today's values:

    - ``"thumbs_up"`` / ``"thumbs_down"`` — native reaction widget click.
    - ``"text"`` — free-form text submitted via a modal/dialog. ``text``
      holds the body; ``prompt`` is the label that was shown above the
      textbox (e.g. ``"What did you think of this reply?"``).
    - ``"reaction"`` — custom emoji reaction; the emoji name is in ``text``.
    - ``"button_click"`` — interactive button on an agent-sent card.
    - ``"prompt_selection"`` — user clicked a suggested prompt.
    - ``"stream_control"`` — stop/pause/resume/regenerate control.
    - ``"message_edit"`` / ``"message_delete"`` — user edited or deleted
      their own message in the platform UI.
    """

    conversation_id: str
    response_id: str             # platform message ID the feedback is attached to
    kind: str
    trace_context: Optional["TraceContext"] = None
    user_id: str = ""
    user_name: str = ""
    text: Optional[str] = None   # populated for "text" and "reaction"
    prompt: Optional[str] = None # populated for "text"


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

    # Optional: adapters that want to receive platform feedback events
    # (thumbs up/down, free-form comments, etc.) define this method. The
    # bridge probes with ``hasattr`` and routes ``FeedbackEvent`` objects
    # to it when feedback arrives. Implementations should NOT block — write
    # to Airtable / a queue / an evals pipeline asynchronously and return.
    #
    # def on_feedback(self, feedback: FeedbackEvent) -> None: ...
