import {
  MessagingClient,
  type AgentResponse,
  type Message,
  type ConversationStream,
} from "@astropods/messaging";

import type { AgentAdapter, ServeOptions, StreamHooks } from "./types";

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
      console.log(`${username}: ${message.content}`);

      this.handleMessage(message);
    });

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

  private handleMessage(message: Message): void {
    if (!this.stream) return;

    const { conversationId } = message;
    const stream = this.stream;

    // Signal start of streaming response
    stream.sendContentChunk(conversationId, { type: "START", content: "" });

    const hooks: StreamHooks = {
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
    };

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
