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

  // Pending audio messages keyed by conversationId, waiting for audio stream data
  private pendingAudioMessages = new Map<string, Message>();

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

      // Check if this is an audio message (content "[audio]" or AUDIO attachment)
      const isAudioMessage =
        message.content === "[audio]" ||
        message.attachments?.some((a) => a.type === "AUDIO");

      const attachmentTypes = (message.attachments ?? []).map((a) => a.type).join(", ");
      console.log(`[bridge] Incoming message: user=${username} conversation=${message.conversationId} content=${JSON.stringify(message.content)} attachments=[${attachmentTypes}] isAudio=${isAudioMessage} hasStreamAudio=${!!this.adapter.streamAudio}`);

      if (isAudioMessage && this.adapter.streamAudio) {
        console.log(`[bridge] Audio message received, waiting for audio stream data...`);
        // Stash the message — audio bytes will arrive via audioConfig/audioChunk events
        this.pendingAudioMessages.set(message.conversationId, message);
      } else if (isAudioMessage && !this.adapter.streamAudio) {
        console.log(`[bridge] Audio message received but adapter does not implement streamAudio, skipping`);
        const hooks = this.buildHooks(message.conversationId);
        this.stream!.sendContentChunk(message.conversationId, { type: "START", content: "" });
        hooks.onChunk("Sorry, I don't support audio input. Please send a text message.");
        hooks.onFinish();
      } else {
        this.handleMessage(message);
      }
    });

    // Listen for streaming audio (WebSocket/Twilio path)
    if (this.adapter.streamAudio) {
      this.stream.on("audioConfig", (config: AudioStreamConfig) => {
        if (!this.stream) return;
        console.log(`[audio] Received audioConfig: encoding=${config.encoding} sampleRate=${config.sampleRate} channels=${config.channels} conversation=${config.conversationId}`);

        // Set up the readable stream immediately, before any audioChunk events fire.
        // audioAsReadable() listens for audioChunk events and pipes them into the stream.
        const audioReadable = this.stream.audioAsReadable();
        const audioInput: AudioInput = {
          stream: audioReadable,
          config,
          filetype: audioEncodingToFiletype(config.encoding),
        };

        const message = this.pendingAudioMessages.get(config.conversationId) ?? null;
        this.pendingAudioMessages.delete(config.conversationId);

        if (!message) {
          console.warn(`[bridge] audioConfig arrived before matching [audio] message — using fallback conversationId=${config.conversationId} userId=anonymous`);
        }

        const conversationId = message?.conversationId ?? config.conversationId;
        const userId = message?.user?.id ?? "anonymous";

        console.log(`[audio] Dispatching to streamAudio: conversation=${conversationId} encoding=${config.encoding} filetype=${audioInput.filetype} userId=${userId}`);
        this.handleAudio(audioInput, conversationId, userId);
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
        console.log(`[bridge] Response complete: conversation=${conversationId}`);
      },
      onTranscript: (text: string) => {
        console.log(`[bridge] Sending transcript: conversation=${conversationId} text=${JSON.stringify(text)}`);
        stream.sendTranscript(conversationId, text);
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

  private handleAudio(
    audioInput: AudioInput,
    conversationId: string,
    userId: string
  ): void {
    if (!this.stream || !this.adapter.streamAudio) return;

    const stream = this.stream;

    console.log(`[bridge] Starting audio response: conversation=${conversationId} userId=${userId} encoding=${audioInput.config.encoding} filetype=${audioInput.filetype}`);
    stream.sendContentChunk(conversationId, { type: "START", content: "" });

    const hooks = this.buildHooks(conversationId);

    this.adapter
      .streamAudio(audioInput, hooks, {
        conversationId,
        userId,
      })
      .then(() => {
        console.log(`[bridge] streamAudio resolved: conversation=${conversationId}`);
      })
      .catch((error) => {
        console.error(`[bridge] streamAudio error: conversation=${conversationId}`, error);
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
