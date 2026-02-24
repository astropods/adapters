import type {
  AgentConfig as MessagingAgentConfig,
  StatusUpdate,
} from "@astropods/messaging";

/** Lifecycle hooks called by an adapter as the agent streams a response. */
export interface StreamHooks {
  onChunk(text: string): void;
  onStatusUpdate(status: StatusUpdate): void;
  onError(error: Error): void;
  onFinish(): void;
}

/** Per-request context passed to the adapter's stream method. */
export interface StreamOptions {
  conversationId: string;
  userId: string;
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

  /** Return agent metadata for playground display (system prompt, tool list). */
  getConfig(): MessagingAgentConfig;
}

/** Options for the serve() entry point and MessagingBridge. */
export interface ServeOptions {
  /** gRPC server address. Defaults to process.env.GRPC_SERVER_ADDR || 'localhost:9090'. */
  serverAddress?: string;
}
