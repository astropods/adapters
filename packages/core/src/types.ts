import type {
  AgentConfig as MessagingAgentConfig,
  AudioStreamConfig,
  StatusUpdate,
} from "@astropods/messaging";

/** Lifecycle hooks called by an adapter as the agent streams a response. */
export interface StreamHooks {
  onChunk(text: string): void;
  onStatusUpdate(status: StatusUpdate): void;
  onError(error: Error): void;
  onFinish(): void;
  /** Called with the observability trace ID once available (before onFinish). */
  onTraceId?(traceId: string): void;
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
}

/** Options for the serve() entry point and MessagingBridge. */
export interface ServeOptions {
  /** gRPC server address. Defaults to process.env.GRPC_SERVER_ADDR || 'localhost:9090'. */
  serverAddress?: string;
}
