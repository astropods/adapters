import type {
  AgentConfig as MessagingAgentConfig,
  AudioStreamConfig,
  PlatformContext,
  StatusUpdate,
} from "@astropods/messaging";

/** Lifecycle hooks called by an adapter as the agent streams a response. */
export interface StreamHooks {
  onChunk(text: string): void;
  onStatusUpdate(status: StatusUpdate): void;
  onError(error: Error): void;
  onFinish(): void;
  /** Send the transcribed text of the user's audio input to update the placeholder. */
  onTranscript(text: string): void;
  /** Send a chunk of TTS audio back to the client. */
  onAudioChunk(data: Uint8Array): void;
  /** Signal end of the current audio response segment. */
  onAudioEnd(): void;
}

/** Per-request context passed to the adapter's stream method. */
export interface StreamOptions {
  conversationId: string;
  userId: string;
  /**
   * Platform-specific context from the source event (channel/thread IDs,
   * workspace, event kind, raw platform user ID, etc.). Undefined when the
   * message did not originate from a platform adapter (e.g. playground or
   * direct gRPC). See `PlatformContext` in `@astropods/messaging` for the
   * full field set.
   */
  platformContext?: PlatformContext;
  /**
   * Aborted when the user stops generation (a `StreamControl` STOP arrives for
   * this conversation, e.g. the chat "stop generating" button). Adapters should
   * forward it to the underlying model call so generation actually halts —
   * otherwise the model runs to completion and its full output is still recorded
   * in telemetry (and can resurface on reload).
   */
  signal?: AbortSignal;
}

/**
 * Inbound feedback from the platform (thumbs up/down, free-form comment,
 * etc.). Passed to {@link AgentAdapter.onFeedback} when the user interacts
 * with a feedback affordance the adapter renders alongside an agent reply.
 *
 * `kind` is a string discriminator. The proto's
 * `PlatformFeedback.feedback` oneof is the source of truth. Current
 * values:
 *  - `"thumbs_up"`, `"thumbs_down"` — synthesized from
 *    `MessageReaction.ReactionType` (THUMBS_UP=1, THUMBS_DOWN=2).
 *  - `"reaction"` — `MessageReaction` with `CUSTOM_EMOJI`. `text` holds
 *    the emoji name.
 *  - `"text"` — `TextFeedback` (modal submission). `text` holds the
 *    user-typed body; `prompt` holds the modal's label.
 *  - `"button_click"`, `"prompt_selection"`, `"stream_control"`,
 *    `"message_edit"`, `"message_delete"` — proto oneof field names.
 *
 * Adapters should handle unknown kinds defensively (ignore or log) so
 * new proto variants don't break existing handlers.
 */
export interface FeedbackEvent {
  conversationId: string;
  /** Platform message ID the feedback is attached to. */
  responseId: string;
  kind: string;
  userId: string;
  userName: string;
  text?: string;
  prompt?: string;
}

/** Audio input delivered to an adapter for processing. */
export interface AudioInput {
  /** ReadableStream of raw audio bytes. */
  stream: ReadableStream<Uint8Array>;
  /** Encoding metadata from the audio session setup. */
  config: AudioStreamConfig;
  /** Mastra-compatible filetype string derived from config.encoding. */
  filetype: string;
}

/**
 * Framework-agnostic interface that any agent adapter must implement.
 * The messaging bridge calls these methods — adapters translate them
 * into the underlying agent framework's API.
 */
export interface AgentAdapter {
  /** Display name for the agent, used in logs and registration. */
  name: string;

  /** Stream a response for the given prompt, invoking hooks as the agent progresses. */
  stream(
    prompt: string,
    hooks: StreamHooks,
    options: StreamOptions
  ): Promise<void>;

  /**
   * Handle audio input — transcribe and respond.
   * Optional: adapters that don't support voice can omit this.
   */
  streamAudio?(
    audio: AudioInput,
    hooks: StreamHooks,
    options: StreamOptions
  ): Promise<void>;

  /** Return agent metadata for playground display (system prompt, tool list). */
  getConfig(): MessagingAgentConfig;

  /**
   * Receive inbound platform feedback (thumbs up/down, free-form comment,
   * button click, prompt selection, etc.). Optional — adapters that don't
   * persist feedback can omit this. May return `void` or a Promise; the
   * bridge does not await the result so callbacks should not block the
   * stream reader on slow IO.
   */
  onFeedback?(feedback: FeedbackEvent): void | Promise<void>;
}

/** Options for the serve() entry point and MessagingBridge. */
export interface ServeOptions {
  /** gRPC server address. Defaults to process.env.GRPC_SERVER_ADDR || 'localhost:9090'. */
  serverAddress?: string;
}
