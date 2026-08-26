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
  type Renderable,
  type RenderableAction,
  type RenderableResponse,
} from "@astropods/messaging";
import { randomUUID } from "node:crypto";

import type {
  AgentAdapter,
  AttachmentInput,
  AudioInput,
  FeedbackEvent,
  ImageInput,
  OutgoingFile,
  RenderableInput,
  SaveConversationInput,
  ServeOptions,
  StreamHooks,
  TraceContext,
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
  url?: string;
};

const DEFAULT_SERVER_ADDR = "localhost:9090";
const MAX_RETRIES = 10;
const INITIAL_DELAY_MS = 500;
const MAX_DELAY_MS = 15000;

// Plain render() default: an escapable submit form.
const DEFAULT_ALLOWED_ACTIONS: RenderableAction[] = [
  "RENDERABLE_ACTION_SUBMIT",
  "RENDERABLE_ACTION_CANCEL",
];

// elicit() is MCP-elicitation-shaped, whose native action set is
// accept / decline / cancel, so it surfaces DECLINE as well as CANCEL.
const DEFAULT_ELICIT_ACTIONS: RenderableAction[] = [
  "RENDERABLE_ACTION_SUBMIT",
  "RENDERABLE_ACTION_DECLINE",
  "RENDERABLE_ACTION_CANCEL",
];

const ACTION_BY_NUMBER: Record<number, RenderableAction> = {
  0: "RENDERABLE_ACTION_UNSPECIFIED",
  1: "RENDERABLE_ACTION_SUBMIT",
  2: "RENDERABLE_ACTION_DECLINE",
  3: "RENDERABLE_ACTION_CANCEL",
  4: "RENDERABLE_ACTION_RESPOND",
  5: "RENDERABLE_ACTION_UNSUPPORTED",
};

// proto-loader may surface an enum as its name, numeric value, or numeric
// string (the StreamControl STOP handling defends the same way). Normalize any
// representation to the canonical name so comparisons are representation-safe.
function normalizeAction(
  action: RenderableAction | number | string
): RenderableAction {
  if (typeof action === "number") {
    return ACTION_BY_NUMBER[action] ?? "RENDERABLE_ACTION_UNSPECIFIED";
  }
  if (/^\d+$/.test(action)) {
    return ACTION_BY_NUMBER[Number(action)] ?? "RENDERABLE_ACTION_UNSPECIFIED";
  }
  return action as RenderableAction;
}

function debug(msg: string) {
  if (process.env.DEBUG) logger.debug(msg);
}

/**
 * Rejection for a strict Renderable (no RESPOND) that reached a surface which
 * cannot render it. Lets out-of-loop callers tell "couldn't ask" apart from a
 * user DECLINE / CANCEL.
 */
export class UnsupportedRenderableError extends Error {
  constructor(public readonly renderableId: string) {
    super(`Renderable ${renderableId} could not be rendered on the target surface`);
    this.name = "UnsupportedRenderableError";
  }
}

export class MessagingBridge {
  private adapter: AgentAdapter;
  private serverAddress: string;
  private client: MessagingClient | null = null;
  private stream: ConversationStream | null = null;
  private shutdownHandler: (() => void) | null = null;
  // In-flight model call per conversation, so a StreamControl STOP can abort it.
  private abortControllers = new Map<string, AbortController>();
  // Live awaiters for blocking Renderables, keyed by Renderable.id. In-process
  // only: correctness across restarts rests on the durable store, not this map.
  private pendingRenderables = new Map<
    string,
    {
      conversationId: string;
      resolve: (r: RenderableResponse) => void;
      reject: (e: Error) => void;
    }
  >();

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
        if (response.feedback.renderableResponse) {
          this.handleRenderableResponse(
            response.feedback.conversationId,
            response.feedback.renderableResponse
          );
          return;
        }
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

    // Per-turn, so a late-unwinding superseded turn can't tag a newer turn.
    let traceContext: TraceContext | undefined;

    // Thread the turn's trace context through the SDK's per-payload senders so
    // the SDK owns how each response is put on the wire. Undefined until
    // onTraceContext fires — the SDK omits the field then.
    const trace = () => (traceContext ? { traceContext } : undefined);

    return {
      onTraceContext: (tc) => {
        if (!tc?.traceparent) return;
        traceContext = tc;
        debug(`[bridge] Trace context attached: conversation=${conversationId}`);
      },
      onChunk: (text: string) => {
        stream.sendContentChunk(conversationId, { type: "DELTA", content: text }, trace());
      },
      onStatusUpdate: (status) => {
        stream.sendStatusUpdate(conversationId, status, trace());
      },
      // No dedicated sender for errors — build the AgentResponse directly.
      onError: (error: Error) => {
        logger.error({ err: error }, "Agent error");
        stream.sendAgentResponse({
          conversationId,
          ...trace(),
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
        stream.sendContentChunk(conversationId, end, trace());
        debug(`[bridge] Response complete: conversation=${conversationId}`);
      },
      onTranscript: (text: string) => {
        debug(`[bridge] Sending transcript: conversation=${conversationId} text=${JSON.stringify(text)}`);
        stream.sendTranscript(conversationId, text, undefined, undefined, trace());
      },
      // Audio uses ConversationRequest.audio — no trace-context slot.
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
      traceContext: fb.traceContext,
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
    // Settle any renderable the aborted turn was blocked on, so `render()` does
    // not hang and the map entry does not leak. The rejection unwinds the
    // adapter's stream() into the aborted-turn path (it checks signal.aborted);
    // the durable store still holds the interaction for redelivery / resume.
    this.rejectPendingRenderables(
      conversationId,
      new Error("Interaction aborted: the turn was stopped or superseded")
    );
  }

  private rejectPendingRenderables(conversationId: string, error: Error): void {
    for (const [id, waiter] of this.pendingRenderables) {
      if (waiter.conversationId === conversationId) {
        this.pendingRenderables.delete(id);
        waiter.reject(error);
      }
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

  /**
   * Resolve inbound IMAGE attachments to the shape the adapter passes to the
   * model. Images arrive inline (bytes in a `data:` URI on `url`), so unlike
   * files there is no volume round trip: the adapter forwards `url` straight to
   * the model as visual content. Attachments without a `url` are skipped.
   */
  private resolveImages(message: Message): ImageInput[] {
    const atts = (message.attachments ?? []) as WireAttachment[];
    const out: ImageInput[] = [];
    for (const a of atts) {
      if (a.type !== "IMAGE") continue;
      if (!a.url) continue;
      out.push({
        name: a.filename || "image",
        url: a.url,
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
        images: this.resolveImages(message),
        signal: controller.signal,
        render: (input) =>
          this.sendRenderable(conversationId, this.buildRenderable(input)),
        elicit: (elicitMessage, dataSchema, opts) =>
          this.sendRenderable(
            conversationId,
            this.buildRenderable({
              message: elicitMessage,
              dataSchema,
              ...opts,
              allowedActions: opts?.allowedActions ?? DEFAULT_ELICIT_ACTIONS,
            })
          ),
        saveConversation: (input) =>
          this.sendSaveConversation(message.user?.id ?? "", input),
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

  /**
   * Copy an external conversation into a user's chat history and return the id
   * it lands on. Defaults the owner to whoever sent the message being handled,
   * which is the common case: the person who asked is the person who gets it.
   */
  private sendSaveConversation(
    turnUserId: string,
    input: SaveConversationInput
  ): string {
    if (!this.stream) {
      throw new Error("saveConversation called with no active stream");
    }
    return this.stream.sendSaveConversation({
      userId: input.userId || turnUserId,
      idempotencyKey: input.idempotencyKey,
      title: input.title,
      sourceLabel: input.sourceLabel,
      sourceUrl: input.sourceUrl,
      messages: input.messages.map((m) => ({
        role: m.role,
        author: m.author,
        content: m.content,
        timestamp: m.timestamp,
      })),
    });
  }

  /** Build a wire Renderable from the friendly render() input, filling defaults. */
  private buildRenderable(input: RenderableInput): Renderable {
    return {
      id: input.id || randomUUID(),
      kind: input.kind ?? "RENDER_KIND_FORM",
      message: input.message,
      dataSchemaJson: JSON.stringify(input.dataSchema),
      valueJson:
        input.value === undefined ? undefined : JSON.stringify(input.value),
      allowedActions: input.allowedActions ?? DEFAULT_ALLOWED_ACTIONS,
      intent: input.intent,
    };
  }

  /**
   * Emit a blocking Renderable and return a promise that settles when the
   * user's response arrives (resolve) or a strict ask cannot be rendered
   * (reject with UnsupportedRenderableError). Correlation is by Renderable.id.
   * The promise is in-process only; cross-restart delivery rests on the durable
   * store and the adapter's onResume hook.
   */
  sendRenderable(
    conversationId: string,
    renderable: Renderable
  ): Promise<RenderableResponse> {
    return new Promise<RenderableResponse>((resolve, reject) => {
      if (!this.stream) {
        reject(new Error("Cannot send a Renderable before the stream is open"));
        return;
      }
      // Every blocking Renderable must offer an escape so a thread can never
      // wedge (spec: allowed_actions must include CANCEL or DECLINE).
      const actions = renderable.allowedActions.map(normalizeAction);
      if (
        !actions.includes("RENDERABLE_ACTION_CANCEL") &&
        !actions.includes("RENDERABLE_ACTION_DECLINE")
      ) {
        reject(
          new Error(
            "A blocking Renderable must offer CANCEL or DECLINE so the user can always escape"
          )
        );
        return;
      }
      this.pendingRenderables.set(renderable.id, {
        conversationId,
        resolve,
        reject,
      });
      try {
        this.stream.sendAgentResponse({ conversationId, renderable });
      } catch (err) {
        this.pendingRenderables.delete(renderable.id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Route an inbound RenderableResponse: settle the live awaiter if one exists
   * (UNSUPPORTED rejects, everything else resolves), otherwise hand it to the
   * adapter's optional onResume (checkpointed frameworks / recovery). We do NOT
   * await onResume, mirroring dispatchFeedback.
   */
  private handleRenderableResponse(
    conversationId: string,
    response: RenderableResponse
  ): void {
    const waiter = this.pendingRenderables.get(response.id);
    if (waiter) {
      this.pendingRenderables.delete(response.id);
      const action = normalizeAction(response.action);
      if (action === "RENDERABLE_ACTION_UNSUPPORTED") {
        waiter.reject(new UnsupportedRenderableError(response.id));
      } else {
        // Hand the adapter the canonical string action even if it arrived numeric.
        waiter.resolve({ ...response, action });
      }
      return;
    }

    if (this.adapter.onResume) {
      try {
        const result = this.adapter.onResume(conversationId, response);
        if (result && typeof (result as Promise<void>).catch === "function") {
          (result as Promise<void>).catch((err) =>
            logger.error({ err }, "onResume rejected; dropping response")
          );
        }
      } catch (err) {
        logger.error({ err }, "onResume threw; dropping response");
      }
      return;
    }

    logger.warn(
      `Renderable response ${response.id} has no in-process awaiter and no onResume handler; dropping`
    );
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
    // Abort in-flight turns first so an adapter blocked on render() unwinds
    // through the quiet aborted-turn path (stream().catch checks signal.aborted)
    // rather than emitting an AGENT_ERROR on a stream we're about to close.
    for (const controller of this.abortControllers.values()) {
      controller.abort();
    }
    this.abortControllers.clear();

    // Fail any in-flight awaiters so a caller blocked on render() doesn't hang
    // past shutdown. The durable store keeps the interaction for redelivery.
    for (const waiter of this.pendingRenderables.values()) {
      waiter.reject(
        new Error("Messaging bridge stopped before the interaction was answered")
      );
    }
    this.pendingRenderables.clear();

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
