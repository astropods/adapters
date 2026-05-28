import type {
  AgentConfig as MessagingAgentConfig,
  AudioStreamConfig,
  PlatformFeedback,
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
}

/**
 * Stable string discriminator for {@link FeedbackEvent.kind} so adapters
 * can switch on it without importing proto enums.
 */
export type FeedbackKind =
  | "thumbs_up"
  | "thumbs_down"
  | "reaction"
  | "text"
  | "button_click"
  | "prompt_selection"
  | "stream_control"
  | "message_edit"
  | "message_delete";

/**
 * Inbound feedback from the platform (thumbs up/down, free-form comment,
 * etc.). Passed to {@link AgentAdapter.onFeedback} when the user interacts
 * with a feedback affordance the adapter renders alongside an agent reply.
 *
 * `text` is populated for `"text"` (free-form modal submission) and for
 * `"reaction"` (the emoji name). `prompt` is populated for `"text"` with
 * the label shown above the textbox. `raw` is the underlying proto for
 * advanced callers.
 */
export interface FeedbackEvent {
  conversationId: string;
  /** Platform message ID the feedback is attached to. */
  responseId: string;
  kind: FeedbackKind | string;
  userId: string;
  userName: string;
  text?: string;
  prompt?: string;
  raw: PlatformFeedback;
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
