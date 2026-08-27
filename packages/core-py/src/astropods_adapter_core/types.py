from __future__ import annotations
from dataclasses import dataclass, field
from datetime import datetime
from typing import (
    TYPE_CHECKING,
    Any,
    Awaitable,
    Callable,
    Optional,
    Protocol,
    runtime_checkable,
)

if TYPE_CHECKING:
    from astropods_messaging import (
        PlatformContext,
        SaveConversationResponse,
        ThreadMessage,
        TraceContext,
    )


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

    def on_file(self, name: str, mime_type: Optional[str] = None, size: Optional[int] = None) -> None:
        """Attach a file the agent produced to the reply (rendered as a download
        chip). Write the bytes into the agent's files dir (AGENT_FILES_DIR) first,
        then call this with the filename; delivered on the END chunk.
        """
        ...

    # Optional: adapters that can provide W3C trace context for the current
    # assistant turn define this method. The bridge implementation supports it,
    # and framework adapters should probe with ``getattr`` before calling it.
    #
    # def on_trace_context(self, trace_context: "TraceContext") -> None: ...


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
class AttachmentInput:
    """A file attached to the incoming message — the user's context for this turn.

    The bytes are staged on the agent's shared files volume; read them at ``path``.
    """

    key: str          # opaque files-API key
    name: str         # original filename
    # Absolute path on the agent's shared files volume. Present only when the
    # message carried the storage key; None otherwise (the filename alone can't
    # locate the on-disk blob), in which case the agent should scan its files dir.
    path: Optional[str] = None
    mime_type: Optional[str] = None
    size: Optional[int] = None


@dataclass
class ImageInput:
    name: str
    url: str          # data:<mime>;base64,<...>
    # Files-API key of the same upload, when the message carried one.
    key: Optional[str] = None
    mime_type: Optional[str] = None
    size: Optional[int] = None


@dataclass
class SavedMessageInput:
    """One turn of an external conversation being copied in."""

    role: str  # "user" or "assistant"
    content: str
    # Original sender's display name. Set it when the copy has several speakers,
    # or every turn renders as the owner's own.
    author: str = ""
    # When the turn happened at the source. Defaults to now.
    timestamp: Optional[datetime] = None


@dataclass
class SaveConversationInput:
    """Input to ``StreamOptions.save_conversation``."""

    # Stable per source conversation and user, e.g. "slack:C123:1699.0001".
    idempotency_key: str
    messages: list[SavedMessageInput] = field(default_factory=list)
    # Astro user id that owns the copy. Defaults to this turn's user_id.
    user_id: str = ""
    title: str = ""
    # Shown with the copy, e.g. "#eng-support".
    source_label: str = ""
    # Deep link back to the source.
    source_url: str = ""
    # What to do when the copy already exists. "SKIP" (default) refreshes a copy
    # the user has not touched and leaves a diverged one alone. "APPEND" adds
    # these messages after whatever is there. "REPLACE" overwrites, throwing away
    # the user's own turns.
    on_conflict: str = "SKIP"


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
    # Files the user attached to this message (the turn's immediate context).
    # The bytes are staged on the shared files volume; read each at its ``path``.
    attachments: list[AttachmentInput] = field(default_factory=list)
    images: list[ImageInput] = field(default_factory=list)
    # Copy a conversation from somewhere else (a Slack thread, an email chain)
    # into a user's Astro chat history, returning the id it lands on.
    #
    # Saving again under the same idempotency_key replaces the copy, so an agent
    # that re-reads its whole source and re-sends it propagates edits and
    # deletions. A copy the user deleted is never recreated, which is how they
    # stop an agent that saves on every source message.
    #
    # Await the status. A copy can be deleted, or the user can have replied in
    # it, and only the agent can decide what to do about either.
    save_conversation: Optional[
        Callable[[SaveConversationInput], Awaitable["SaveConversationResponse"]]
    ] = None
    # Read the source thread this turn belongs to, hydrated from the platform so
    # edits and deletions are reflected. The prompt only carries the message that
    # triggered the turn; this is how an agent sees the rest of the conversation.
    get_thread_history: Optional[
        Callable[[int], Awaitable[list["ThreadMessage"]]]
    ] = None


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
