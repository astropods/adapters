import { join } from "node:path";
import {
  MessagingClient,
  audioEncodingToFiletype,
  type AgentResponse,
  type Attachment,
  type AudioStreamConfig,
  type Message,
  type ConversationStream,
  type PlatformFeedback,
} from "@astropods/messaging";

import type {
  AgentAdapter,
  AttachmentInput,
  AudioInput,
  FeedbackEvent,
  OutgoingFile,
  ServeOptions,
  StreamHooks,
} from "./types.js";
import { logger } from "./logger.js";

/** Default agent files mount, matching the K8s/compose deployer's AGENT_FILES_DIR. */
const DEFAULT_AGENT_FILES_DIR = "/data/files";

/** On-disk suffix the files store uses for API-managed uploads (see the sidecar's
 *  FSStore). Inbound attachments are always API uploads, so the blob for key K is
 *  at <AGENT_FILES_DIR>/<K>.blob. */
const FILES_BLOB_SUFFIX = ".blob";

/** The wire fields we read off an inbound attachment. `storageKey`/`sizeBytes`
 *  are present at runtime (proto-loader) and declared on the SDK's Attachment as
 *  of the storage_key proto addition; typed here so the bridge builds against a
 *  not-yet-republished SDK too. */
type WireAttachment = Attachment & {
  storageKey?: string;
  sizeBytes?: number;
};

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
  // In-flight model call per conversation, so a StreamControl STOP can abort it.
  private abortControllers = new Map<string, AbortController>();

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
        this.maybeAbortOnStreamControl(response.feedback);
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

    // Files the agent emits via onFile are buffered and delivered on the END
    // chunk (ResponseAttachment.file), since the client renders reply download
    // chips off the terminal chunk. The agent has already written the bytes to
    // its files dir; only the filename (its files-API key) rides the wire.
    const pendingFiles: OutgoingFile[] = [];

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
      onFile: (file: OutgoingFile) => {
        pendingFiles.push(file);
      },
      onFinish: () => {
        // Only attach the array when the agent produced files, so a plain reply's
        // END chunk stays exactly `{ type, content }`.
        const end: { type: "END"; content: string; attachments?: unknown[] } = {
          type: "END",
          content: "",
        };
        if (pendingFiles.length > 0) {
          end.attachments = pendingFiles.map((f) => ({
            file: {
              filename: f.name,
              mimeType: f.mimeType,
              sizeBytes: f.size,
            },
          }));
        }
        stream.sendContentChunk(conversationId, end);
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

  /**
   * Abort the in-flight model call for a conversation when a StreamControl STOP
   * feedback arrives (chat "stop generating"). The action is compared loosely
   * because proto-loader may surface the enum as a string ("STOP") or number.
   * With no cooperating agent this is a no-op; with one, generation halts so
   * telemetry records only the partial.
   */
  private maybeAbortOnStreamControl(fb: PlatformFeedback): void {
    const action = fb.streamControl?.action;
    const isStop = action === "STOP" || action === 1 || action === "1";
    if (!isStop) return;
    this.abortInFlight(fb.conversationId);
    debug(`[bridge] Stop received; aborting generation: conversation=${fb.conversationId}`);
  }

  private abortInFlight(conversationId: string): void {
    const existing = this.abortControllers.get(conversationId);
    if (existing) {
      existing.abort();
      this.abortControllers.delete(conversationId);
    }
  }

  /**
   * Resolve inbound FILE attachments to the shape agent code consumes: the
   * files-API key, display metadata, and an absolute path on the agent's shared
   * files volume (AGENT_FILES_DIR). Image/audio/etc. are ignored here (audio is
   * handled by the dedicated audio path).
   */
  private resolveAttachments(message: Message): AttachmentInput[] {
    const dir = process.env.AGENT_FILES_DIR || DEFAULT_AGENT_FILES_DIR;
    const atts = (message.attachments ?? []) as WireAttachment[];
    const out: AttachmentInput[] = [];
    for (const a of atts) {
      if (a.type !== "FILE") continue;
      const key = a.storageKey || a.filename;
      if (!key) continue;
      // Only resolve a path from the storage key — the filename can't locate the
      // on-disk blob (`<key>.blob`). Without a storage key (older sidecar/proto),
      // omit path so the agent falls back to scanning rather than reading a
      // non-existent file.
      const path = a.storageKey
        ? join(dir, `${a.storageKey}${FILES_BLOB_SUFFIX}`)
        : undefined;
      out.push({
        key,
        name: a.filename || key,
        path,
        mimeType: a.mimeType,
        size: a.sizeBytes,
      });
    }
    return out;
  }

  private handleMessage(message: Message): void {
    if (!this.stream) return;

    const { conversationId } = message;
    const stream = this.stream;

    // A new turn supersedes any prior in-flight turn on this conversation.
    this.abortInFlight(conversationId);
    const controller = new AbortController();
    this.abortControllers.set(conversationId, controller);

    // Signal start of streaming response
    stream.sendContentChunk(conversationId, { type: "START", content: "" });

    const hooks = this.buildHooks(conversationId);

    this.adapter
      .stream(message.content, hooks, {
        conversationId,
        // || catches empty strings too — ?? would let "" through.
        userId: message.user?.id || "anonymous",
        platformContext: message.platformContext,
        attachments: this.resolveAttachments(message),
        signal: controller.signal,
      })
      .catch((error) => {
        // A user stop aborts the model call — that's expected; end quietly
        // rather than surfacing an error to the client.
        //
        // We deliberately do NOT emit a terminal END here. Cancel finalization
        // is owned by the sidecar: HandleCancel broadcasts the finish and closes
        // the SSE (and astro-server clears the stream marker), so the client and
        // chat store are already finalized. An END sent from here would only race
        // that finish — and on the /cancel path the sidecar's stop-gate would
        // drop it anyway (a non-START content chunk on a stopped conversation).
        if (controller.signal.aborted) {
          debug(`[bridge] Generation aborted by stop: conversation=${conversationId}`);
          return;
        }
        hooks.onError(
          error instanceof Error ? error : new Error(String(error))
        );
      })
      .finally(() => {
        // Only clear if we're still the active turn (a newer turn may have
        // replaced us).
        if (this.abortControllers.get(conversationId) === controller) {
          this.abortControllers.delete(conversationId);
        }
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
