import {
  MessagingClient,
  audioEncodingToFiletype,
  type AgentResponse,
  type AudioStreamConfig,
  type Message,
  type ConversationStream,
  type PlatformFeedback,
} from "@astropods/messaging";

import type {
  AgentAdapter,
  AudioInput,
  FeedbackEvent,
  ServeOptions,
  StreamHooks,
  StreamOptions,
} from "./types";
import { logger } from "./logger";

const DEFAULT_SERVER_ADDR = "localhost:9090";
const MAX_RETRIES = 10;
const INITIAL_DELAY_MS = 500;
const MAX_DELAY_MS = 15000;

function debug(msg: string) {
  if (process.env.DEBUG) logger.debug(msg);
}

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
        logger.info(`Connected to messaging service (health: ${health.status})`);
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
        logger.info(
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

    logger.info(`Starting ${agentName}...`);
    logger.info(`  gRPC Server: ${this.serverAddress}`);

    await this.connectWithRetry();

    // Open bidirectional stream
    this.stream = this.client!.createConversationStream();

    // Send agent config for playground display
    this.stream.sendAgentConfig(config);
    logger.info("Agent config sent");

    // Listen for incoming messages
    this.stream.on("response", (response: AgentResponse) => {
      if (response.feedback) {
        this.dispatchFeedback(response.feedback);
        return;
      }

      if (!response.incomingMessage) return;

      const message = response.incomingMessage;

      // "[audio]" placeholder messages are handled via the audioConfig event —
      // just ignore them here. If the adapter doesn't support audio, reply with
      // a helpful error.
      const isAudioMessage =
        message.content === "[audio]" ||
        message.attachments?.some((a) => a.type === "AUDIO");

      if (isAudioMessage) {
        if (!this.adapter.streamAudio) {
          const hooks = this.buildHooks(message.conversationId);
          this.stream!.sendContentChunk(message.conversationId, { type: "START", content: "" });
          hooks.onChunk("Sorry, I don't support audio input. Please send a text message.");
          hooks.onFinish();
        }
        return;
      }

      this.handleMessage(message);
    });

    // Listen for streaming audio (WebSocket/Twilio path).
    // audioConfig carries the conversationId — no need to correlate with the
    // "[audio]" text message.
    if (this.adapter.streamAudio) {
      this.stream.on("audioConfig", (config: AudioStreamConfig) => {
        if (!this.stream) return;
        debug(`[audio] Received audioConfig: encoding=${config.encoding} sampleRate=${config.sampleRate} channels=${config.channels} conversation=${config.conversationId}`);

        // Set up the readable stream immediately, before any audioChunk events fire.
        // audioAsReadable() listens for audioChunk events and pipes them into the stream.
        const audioReadable = this.stream.audioAsReadable();
        const audioInput: AudioInput = {
          stream: audioReadable,
          config,
          filetype: audioEncodingToFiletype(config.encoding),
        };

        this.handleAudio(audioInput, config.conversationId, config.userId);
      });
    }

    this.stream.on("error", (error: Error) => {
      logger.error({ err: error }, "Stream error");
    });

    this.stream.on("end", () => {
      logger.info("Stream ended");
    });

    // Register the agent
    this.stream.sendMessage({
      conversationId: "agent-registration",
      platform: "grpc",
      content: "Agent ready",
      user: { id: agentId, username: agentName },
    });

    logger.info(`${agentName} is ready and listening for messages`);

    // Graceful shutdown (store reference so stop() can remove the listeners)
    this.shutdownHandler = () => {
      logger.info("Shutting down...");
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
        logger.error({ err: error }, "Agent error");
        stream.sendAgentResponse({
          conversationId,
          error: { code: "AGENT_ERROR", message: error.message },
        });
      },
      onFinish: () => {
        stream.sendContentChunk(conversationId, { type: "END", content: "" });
        debug(`[bridge] Response complete: conversation=${conversationId}`);
      },
      onTranscript: (text: string) => {
        debug(`[bridge] Sending transcript: conversation=${conversationId} text=${JSON.stringify(text)}`);
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

  /**
   * Convert an incoming PlatformFeedback proto into a FeedbackEvent and pass
   * it to the adapter's optional onFeedback callback. We do NOT await the
   * callback so a slow Airtable write (or similar) can't stall the stream
   * reader. Exceptions are logged and swallowed for the same reason.
   */
  private dispatchFeedback(fb: PlatformFeedback): void {
    if (!this.adapter.onFeedback) return;

    let kind: string = "";
    let text: string | undefined;
    let prompt: string | undefined;

    if (fb.reaction) {
      // Reaction enum: UNSPECIFIED=0, THUMBS_UP=1, THUMBS_DOWN=2, CUSTOM_EMOJI=3
      switch (fb.reaction.type) {
        case 1:
          kind = "thumbs_up";
          break;
        case 2:
          kind = "thumbs_down";
          break;
        case 3:
          kind = "reaction";
          text = fb.reaction.emoji;
          break;
        default:
          kind = "reaction";
      }
    } else if (fb.text) {
      kind = "text";
      text = fb.text.text;
      prompt = fb.text.prompt;
    } else if (fb.buttonClick) {
      kind = "button_click";
    } else if (fb.promptSelection) {
      kind = "prompt_selection";
    } else if (fb.streamControl) {
      kind = "stream_control";
    } else if (fb.messageEdit) {
      kind = "message_edit";
    } else if (fb.messageDelete) {
      kind = "message_delete";
    }

    const event: FeedbackEvent = {
      conversationId: fb.conversationId,
      // Proto fields are typed optional on the wire but the bridge always
      // surfaces empty strings rather than undefined so callbacks can write
      // `event.userId` straight to a row without null-checking every field.
      responseId: fb.responseId ?? "",
      kind,
      userId: fb.user?.id ?? "",
      userName: fb.user?.username ?? "",
      text,
      prompt,
    };

    try {
      const result = this.adapter.onFeedback(event);
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch((err) =>
          logger.error({ err }, "onFeedback rejected; dropping event")
        );
      }
    } catch (err) {
      logger.error({ err }, "onFeedback threw; dropping event");
    }
  }

  private handleMessage(message: Message): void {
    if (!this.stream) return;

    const { conversationId } = message;
    const stream = this.stream;

    // Signal start of streaming response
    stream.sendContentChunk(conversationId, { type: "START", content: "" });

    const hooks = this.buildHooks(conversationId);
    const options: StreamOptions = {
      conversationId,
      // || catches empty strings too — ?? would let "" through.
      userId: message.user?.id || "anonymous",
      platform: message.platform,
    };
    if (message.platformContext) {
      options.platformContext = message.platformContext;
    }

    this.adapter
      .stream(message.content, hooks, options)
      .catch((error) => {
        hooks.onError(
          error instanceof Error ? error : new Error(String(error))
        );
      });
  }

  private handleAudio(audioInput: AudioInput, conversationId: string, userId?: string): void {
    if (!this.stream || !this.adapter.streamAudio) return;

    const stream = this.stream;

    debug(`[bridge] Starting audio response: conversation=${conversationId} encoding=${audioInput.config.encoding} filetype=${audioInput.filetype}`);
    stream.sendContentChunk(conversationId, { type: "START", content: "" });

    const hooks = this.buildHooks(conversationId);

    this.adapter
      .streamAudio(audioInput, hooks, {
        conversationId,
        // || catches empty strings too — ?? would let "" through.
        userId: userId || "anonymous",
        // audioConfig doesn't carry platform context; Slack team tagging only applies to text messages.
      })
      .then(() => {
        debug(`[bridge] streamAudio resolved: conversation=${conversationId}`);
      })
      .catch((error) => {
        logger.error({ err: error }, `[bridge] streamAudio error: conversation=${conversationId}`);
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
