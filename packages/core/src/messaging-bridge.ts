import {
  MessagingClient,
  audioEncodingToFiletype,
  type AgentResponse,
  type AudioStreamConfig,
  type Message,
  type ConversationStream,
} from "@astropods/messaging";

import type { AgentAdapter, AudioInput, ServeOptions, StreamHooks } from "./types";

const DEFAULT_SERVER_ADDR = "localhost:9090";
const MAX_RETRIES = 10;
const INITIAL_DELAY_MS = 500;
const MAX_DELAY_MS = 15000;

export class MessagingBridge {
  private adapter: AgentAdapter;
  private serverAddress: string;
  private client: MessagingClient | null = null;
  private stream: ConversationStream | null = null;
  private shutdownHandler: (() => void) | null = null;

  constructor(adapter: AgentAdapter, options?: ServeOptions) {
    this.adapter = adapter;
    this.serverAddress =
      options?.serverAddress ||
      process.env.GRPC_SERVER_ADDR ||
      DEFAULT_SERVER_ADDR;
  }

  private async connectWithRetry(): Promise<void> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        this.client = new MessagingClient(this.serverAddress);
        await this.client.connect();
        const health = await this.client.healthCheck();
        console.log(`Connected to messaging service (health: ${health.status})`);
        return;
      } catch (error) {
        if (this.client) {
          this.client.close();
          this.client = null;
        }
        if (attempt === MAX_RETRIES) {
          throw error;
        }
        const delay = Math.min(INITIAL_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
        console.log(
          `Waiting for messaging service (attempt ${attempt}/${MAX_RETRIES}, retry in ${delay}ms)...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  async start(): Promise<void> {
    const config = this.adapter.getConfig();
    const agentName = this.adapter.name;
    const agentId = agentName.toLowerCase().replace(/\s+/g, "-");

    console.log(`Starting ${agentName}...`);
    console.log(`  gRPC Server: ${this.serverAddress}`);

    await this.connectWithRetry();

    // Open bidirectional stream
    this.stream = this.client!.createConversationStream();

    // Send agent config for playground display
    this.stream.sendAgentConfig(config);
    console.log("Agent config sent");

    // Listen for incoming messages
    this.stream.on("response", (response: AgentResponse) => {
      if (!response.incomingMessage) return;

      const message = response.incomingMessage;
      const username =
        message.user?.username || message.user?.id || "Anonymous";

      // Check for audio attachment (batch upload path)
      const audioAttachment = message.attachments?.find(
        (a) => a.type === "AUDIO"
      );

      if (audioAttachment && this.adapter.streamAudio) {
        console.log(`${username}: [audio message]`);
        this.handleAudioAttachment(message, audioAttachment);
      } else {
        console.log(`${username}: ${message.content}`);
        this.handleMessage(message);
      }
    });

    // Listen for streaming audio (WebSocket/Twilio path)
    if (this.adapter.streamAudio) {
      let pendingAudioConfig: AudioStreamConfig | null = null;

      this.stream.on("audioConfig", (config: AudioStreamConfig) => {
        pendingAudioConfig = config;
      });

      this.stream.on("audioChunk", () => {
        // Audio chunks are consumed via audioAsReadable() below — this
        // listener just triggers stream creation on the first chunk.
        if (!pendingAudioConfig || !this.stream) return;

        const config = pendingAudioConfig;
        pendingAudioConfig = null;

        const audioReadable = this.stream.audioAsReadable();
        const audioInput: AudioInput = {
          stream: audioReadable,
          config,
          filetype: audioEncodingToFiletype(config.encoding),
        };

        const conversationId = config.conversationId;
        console.log(`[audio stream] conversation=${conversationId} encoding=${config.encoding}`);
        this.handleAudio(audioInput, conversationId);
      });
    }

    this.stream.on("error", (error: Error) => {
      console.error("Stream error:", error);
    });

    this.stream.on("end", () => {
      console.log("Stream ended");
    });

    // Register the agent
    this.stream.sendMessage({
      conversationId: "agent-registration",
      platform: "grpc",
      content: "Agent ready",
      user: { id: agentId, username: agentName },
    });

    console.log(`${agentName} is ready and listening for messages`);

    // Graceful shutdown (store reference so stop() can remove the listeners)
    this.shutdownHandler = () => {
      console.log("Shutting down...");
      this.stop();
      process.exit(0);
    };
    process.on("SIGINT", this.shutdownHandler);
    process.on("SIGTERM", this.shutdownHandler);
  }

  private buildHooks(conversationId: string): StreamHooks {
    const stream = this.stream!;

    return {
      onChunk: (text: string) => {
        stream.sendContentChunk(conversationId, {
          type: "DELTA",
          content: text,
        });
      },
      onStatusUpdate: (status) => {
        stream.sendStatusUpdate(conversationId, status);
      },
      onError: (error: Error) => {
        console.error("Agent error:", error);
        stream.sendAgentResponse({
          conversationId,
          error: { code: "AGENT_ERROR", message: error.message },
        });
      },
      onFinish: () => {
        stream.sendContentChunk(conversationId, { type: "END", content: "" });
        console.log("Response complete");
      },
      onAudioChunk: (data: Uint8Array) => {
        stream.sendAudioChunk({ data, done: false });
      },
      onAudioEnd: () => {
        stream.endAudio();
      },
    };
  }

  private handleMessage(message: Message): void {
    if (!this.stream) return;

    const { conversationId } = message;
    const stream = this.stream;

    // Signal start of streaming response
    stream.sendContentChunk(conversationId, { type: "START", content: "" });

    const hooks = this.buildHooks(conversationId);

    this.adapter
      .stream(message.content, hooks, {
        conversationId,
        userId: message.user?.id ?? "anonymous",
      })
      .catch((error) => {
        hooks.onError(
          error instanceof Error ? error : new Error(String(error))
        );
      });
  }

  private handleAudioAttachment(
    message: Message,
    attachment: { url?: string; mimeType?: string }
  ): void {
    if (!this.stream || !this.adapter.streamAudio) return;

    const { conversationId } = message;
    const stream = this.stream;

    // Extract audio metadata from platform data
    const pd = message.platformContext?.platformData ?? {};
    const encoding = (pd["audio_encoding"] ?? "WEBM_OPUS").toUpperCase();
    const sampleRate = parseInt(pd["audio_sample_rate"] ?? "48000", 10);
    const channels = parseInt(pd["audio_channels"] ?? "1", 10);

    const config: AudioStreamConfig = {
      encoding: encoding as AudioStreamConfig["encoding"],
      sampleRate,
      channels,
      language: pd["audio_language"],
      conversationId,
      source: pd["audio_source"],
    };

    // Fetch the audio data from the attachment URL and wrap as ReadableStream
    if (!attachment.url) {
      console.error("Audio attachment has no URL");
      return;
    }

    stream.sendContentChunk(conversationId, { type: "START", content: "" });

    const hooks = this.buildHooks(conversationId);

    fetch(attachment.url)
      .then((res) => {
        if (!res.ok || !res.body) {
          throw new Error(`Failed to fetch audio: ${res.status}`);
        }

        const audioInput: AudioInput = {
          stream: res.body,
          config,
          filetype: audioEncodingToFiletype(config.encoding),
        };

        return this.adapter.streamAudio!(audioInput, hooks, {
          conversationId,
          userId: message.user?.id ?? "anonymous",
        });
      })
      .catch((error) => {
        hooks.onError(
          error instanceof Error ? error : new Error(String(error))
        );
      });
  }

  private handleAudio(audioInput: AudioInput, conversationId: string): void {
    if (!this.stream || !this.adapter.streamAudio) return;

    const stream = this.stream;

    stream.sendContentChunk(conversationId, { type: "START", content: "" });

    const hooks = this.buildHooks(conversationId);

    this.adapter
      .streamAudio(audioInput, hooks, {
        conversationId,
        userId: "anonymous",
      })
      .catch((error) => {
        hooks.onError(
          error instanceof Error ? error : new Error(String(error))
        );
      });
  }

  stop(): void {
    if (this.shutdownHandler) {
      process.removeListener("SIGINT", this.shutdownHandler);
      process.removeListener("SIGTERM", this.shutdownHandler);
      this.shutdownHandler = null;
    }
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
    if (this.client) {
      this.client.close();
      this.client = null;
    }
  }
}
