import type { Agent } from "@mastra/core/agent";
import type {
  AgentConfig as MessagingAgentConfig,
  RenderableAction,
} from "@astropods/messaging";
import type { AgentAdapter, AudioInput, StreamHooks, StreamOptions } from "@astropods/adapter-core";
import { UnsupportedRenderableError, createTraceparent, logger } from "@astropods/adapter-core";

/** The object agent.stream()/approveToolCall()/resumeStream() all resolve to. */
type MastraStream = Awaited<ReturnType<Agent["stream"]>>;

// Approve / deny a tool-permission ask. A permission has no form to fill, so
// declining is the escape rather than cancelling.
const APPROVAL_ACTIONS: RenderableAction[] = [
  "RENDERABLE_ACTION_SUBMIT",
  "RENDERABLE_ACTION_DECLINE",
];

// Submit the form, answer in your own words, or dismiss. Dismissing aborts the
// turn since Mastra has no way to decline a suspended tool.
const ELICIT_ACTIONS: RenderableAction[] = [
  "RENDERABLE_ACTION_SUBMIT",
  "RENDERABLE_ACTION_RESPOND",
  "RENDERABLE_ACTION_CANCEL",
];

/** Extract a human prompt from a tool's suspend payload, else a generic ask. */
function suspensionMessage(suspendPayload: unknown): string {
  if (suspendPayload && typeof suspendPayload === "object") {
    for (const key of ["message", "prompt", "reason", "question"]) {
      const v = (suspendPayload as Record<string, unknown>)[key];
      if (typeof v === "string" && v.trim()) return v;
    }
  }
  if (typeof suspendPayload === "string" && suspendPayload.trim()) {
    return suspendPayload;
  }
  return "The agent needs more information to continue.";
}

/** Mastra serializes a tool's resumeSchema as a JSON-Schema string. */
function parseResumeSchema(raw: string): object {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Plain-text `key: value` summary of a tool call's arguments, shown as the
 * permission subtext so the user sees what will run (e.g. which file). The
 * client renders the message as plain text, so no markdown here; the tool name
 * is carried separately as the Renderable's schema title.
 */
function argsSummary(args: unknown): string {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  return Object.entries(args as Record<string, unknown>)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n");
}

function attachmentNote(
  attachments: NonNullable<StreamOptions["attachments"]>,
  images: NonNullable<StreamOptions["images"]>
): string {
  const shown = new Set(images.map((i) => i.key).filter(Boolean));
  const files = attachments.filter((a) => a.path && !shown.has(a.key));
  if (files.length === 0) return "";
  const list = files.map((f) => `${f.name} (${f.path})`).join(", ");
  return `The user attached these files, readable at these paths: ${list}`;
}

export interface MastraAdapterOptions {
  supportsFiles?: boolean;
}

/**
 * Adapts a Mastra Agent to the Astro messaging protocol.
 *
 * Translates Mastra's fullStream chunk types into the StreamHooks lifecycle
 * that the MessagingBridge expects. Mastra's native tool-approval and
 * tool-suspension pauses are bridged to the elicitation API: a paused stream
 * surfaces as a Renderable, and the user's response resumes it.
 */
export class MastraAdapter implements AgentAdapter {
  readonly name: string;
  private readonly supportsFiles: boolean;

  constructor(private agent: Agent, options: MastraAdapterOptions = {}) {
    this.name = agent.name;
    this.supportsFiles = options.supportsFiles ?? false;
  }

  async stream(
    prompt: string,
    hooks: StreamHooks,
    options: StreamOptions
  ): Promise<void> {
    // Backfill the langfuse trace user_id only (Unauthorized bucket, not
    // Unattributed); memory.resource keeps the original to scope memory.
    const traceUserId = options.userId || "anonymous";

    // When the message carried images, hand the model a single user message
    // whose content mixes the prompt text with image parts (bytes ride in each
    // image's data-URI `url`). Otherwise pass the plain prompt string so the
    // common text path is untouched.
    const images = options.images ?? [];
    const note = attachmentNote(options.attachments ?? [], images);
    const text = note ? (prompt ? `${prompt}\n\n${note}` : note) : prompt;
    const input =
      images.length > 0
        ? [
            {
              role: "user" as const,
              content: [
                ...(text ? [{ type: "text" as const, text }] : []),
                ...images.map((img) => ({
                  type: "image" as const,
                  image: img.url,
                  // Set mediaType explicitly; a missing one defaults to
                  // image/jpeg, which the model rejects for non-JPEG bytes.
                  mediaType:
                    img.mimeType ?? /^data:([^;,]+)[;,]/.exec(img.url)?.[1],
                })),
              ],
            },
          ]
        : text;

    const stream = await this.agent.stream(input, {
      memory: {
        thread: options.conversationId,
        resource: options.userId,
      },
      tracingOptions: {
        metadata: {
          "langfuse.user.id": traceUserId,
          "langfuse.session.id": options.conversationId,
        },
      },
      // Forward the stop signal so a "stop generating" actually aborts the model
      // call — Mastra force-closes the stream and the LLM request is cancelled,
      // so telemetry records only the partial rather than the full completion.
      abortSignal: options.signal,
    });
    const traceparent = createTraceparent({
      traceId: stream.traceId,
      spanId: stream.spanId,
    });
    if (traceparent) {
      hooks.onTraceContext?.({ traceparent });
    }

    // Track tool names by call ID so we can reference them when the call ends
    // (the end chunk only carries toolCallId, not toolName).
    const toolNames = new Map<string, string>();

    // A tool that needs approval or user input pauses the stream and hands back
    // a continuation to resume. Consume each segment until the turn ends.
    let segment: MastraStream | null = stream;
    while (segment) {
      segment = await this.consumeSegment(segment, hooks, options, toolNames);
    }
  }

  /**
   * Consume one stream segment. Returns the continuation stream when the agent
   * paused for a Renderable and the user resolved it, or null when the turn
   * ended (finished, aborted, or the user dismissed a suspension).
   */
  private async consumeSegment(
    stream: MastraStream,
    hooks: StreamHooks,
    options: StreamOptions,
    toolNames: Map<string, string>
  ): Promise<MastraStream | null> {
    const runId = stream.runId;
    let pause:
      | { kind: "approval" | "suspend"; toolCallId: string; toolName: string; args: unknown; resumeSchema: string; suspendPayload?: unknown }
      | null = null;

    for await (const chunk of stream.fullStream) {
      // Once stopped, drop any trailing chunks (including a Mastra abort/error
      // chunk) so we neither emit more text nor surface a spurious error.
      if (options.signal?.aborted) return null;
      // A pause closes the segment; ignore anything Mastra emits after it.
      if (pause) continue;
      switch (chunk.type) {
        case "text-delta":
          hooks.onChunk(chunk.payload.text);
          break;

        case "reasoning-start":
          hooks.onStatusUpdate({ status: "THINKING" });
          break;

        case "reasoning-end":
          hooks.onStatusUpdate({ status: "GENERATING" });
          break;

        case "tool-call-input-streaming-start":
          toolNames.set(chunk.payload.toolCallId, chunk.payload.toolName);
          hooks.onStatusUpdate({
            status: "PROCESSING",
            customMessage: `Running ${chunk.payload.toolName}`,
          });
          break;

        case "tool-call-input-streaming-end": {
          const toolName = toolNames.get(chunk.payload.toolCallId) ?? "tool";
          toolNames.delete(chunk.payload.toolCallId);
          hooks.onStatusUpdate({
            status: "ANALYZING",
            customMessage: `Finished ${toolName}`,
          });
          break;
        }

        case "tool-call-approval":
          pause = { kind: "approval", ...chunk.payload };
          break;

        case "tool-call-suspended":
          pause = { kind: "suspend", ...chunk.payload };
          break;

        case "finish":
          hooks.onFinish();
          break;

        case "error":
          hooks.onError(
            chunk.payload.error instanceof Error
              ? chunk.payload.error
              : new Error(String(chunk.payload.error))
          );
          break;
      }
    }

    if (options.signal?.aborted || !pause) return null;
    return pause.kind === "approval"
      ? this.resolveApproval(runId, pause.toolCallId, pause.toolName, pause.args, hooks, options)
      : this.resolveSuspension(runId, pause.toolCallId, pause.resumeSchema, pause.suspendPayload, hooks, options);
  }

  /**
   * Bridge a tool-permission pause: render a permission Renderable and approve
   * or decline the tool call. Without a render surface, or when the surface
   * can't render, deny — declining lets the agent continue and explain.
   */
  private async resolveApproval(
    runId: string,
    toolCallId: string,
    toolName: string,
    args: unknown,
    hooks: StreamHooks,
    options: StreamOptions
  ): Promise<MastraStream | null> {
    const decline = () =>
      this.agent.declineToolCall({ runId, toolCallId, abortSignal: options.signal });
    if (!options.render) return decline();

    let response;
    try {
      response = await options.render({
        // The client renders intent "tool_permission" from schema.title (the
        // tool name, humanized as the heading) and the message (args subtext).
        message: argsSummary(args),
        dataSchema: { title: await this.resolveToolId(toolName) },
        value: args,
        allowedActions: APPROVAL_ACTIONS,
        intent: "tool_permission",
      });
    } catch (err) {
      if (err instanceof UnsupportedRenderableError) return decline();
      throw err;
    }

    return response.action === "RENDERABLE_ACTION_SUBMIT"
      ? this.agent.approveToolCall({ runId, toolCallId, abortSignal: options.signal })
      : decline();
  }

  /**
   * The tool's own `id` (e.g. "delete_file") rather than Mastra's registration
   * key (the JS property name, e.g. "deleteFileTool", which reads oddly).
   * listTools() is async in current Mastra; fall back to the key.
   */
  private async resolveToolId(toolName: string): Promise<string> {
    try {
      const tools = await this.agent.listTools?.();
      const tool = tools?.[toolName] as { id?: string } | undefined;
      if (tool?.id) return tool.id;
    } catch {
      // Fall back to the registration key.
    }
    return toolName;
  }

  /**
   * Bridge a tool-suspension pause: elicit the input described by the tool's
   * resumeSchema and resume the run with it. Dismissing (or no elicit surface)
   * aborts the turn — Mastra has no native way to decline a suspension, so we
   * end cleanly rather than tell the agent to continue.
   */
  private async resolveSuspension(
    runId: string,
    toolCallId: string,
    resumeSchema: string,
    suspendPayload: unknown,
    hooks: StreamHooks,
    options: StreamOptions
  ): Promise<MastraStream | null> {
    const abort = () => {
      hooks.onFinish();
      return null;
    };
    if (!options.elicit) return abort();

    let response;
    try {
      response = await options.elicit(
        suspensionMessage(suspendPayload),
        parseResumeSchema(resumeSchema),
        { allowedActions: ELICIT_ACTIONS }
      );
    } catch (err) {
      if (err instanceof UnsupportedRenderableError) return abort();
      throw err;
    }

    switch (response.action) {
      case "RENDERABLE_ACTION_SUBMIT": {
        const resumeData = response.contentJson ? JSON.parse(response.contentJson) : {};
        return this.agent.resumeStream(resumeData, { runId, toolCallId, abortSignal: options.signal });
      }
      default:
        // RESPOND / CANCEL / DECLINE all end this turn. For RESPOND the surface
        // starts a fresh turn with the user's prose, so the adapter must not re-feed
        // it here — doing so would double the turn.
        return abort();
    }
  }

  async streamAudio(
    audio: AudioInput,
    hooks: StreamHooks,
    options: StreamOptions
  ): Promise<void> {
    const voice = this.agent.voice;
    if (!voice) {
      logger.error("[MastraAdapter] streamAudio called but agent has no voice provider");
      hooks.onError(new Error("Agent has no voice provider configured"));
      return;
    }

    logger.debug(`[MastraAdapter] streamAudio: encoding=${audio.config.encoding} filetype=${audio.filetype} conversation=${options.conversationId}`);

    // STT: transcribe audio to text
    hooks.onStatusUpdate({ status: "PROCESSING", customMessage: "Transcribing audio" });

    let transcript: string;
    try {
      logger.debug("[MastraAdapter] Calling voice.listen() for STT...");
      const result = await voice.listen(audio.stream, {
        filetype: audio.filetype,
      });
      transcript = typeof result === "string" ? result : String(result ?? "");
      logger.debug(`[MastraAdapter] STT result: "${transcript.substring(0, 100)}${transcript.length > 100 ? "..." : ""}"`);

      // Send transcript back to update the placeholder user message
      hooks.onTranscript(transcript);
    } catch (error) {
      logger.error({ err: error }, "[MastraAdapter] STT failed");
      hooks.onError(
        error instanceof Error ? error : new Error(String(error))
      );
      return;
    }

    if (!transcript.trim()) {
      logger.warn("[MastraAdapter] STT returned empty transcript");
      hooks.onError(new Error("Could not transcribe audio"));
      return;
    }

    // Generate a text response using the transcript as the prompt.
    // When TTS is available, intercept chunks to accumulate text and defer
    // onFinish until after TTS completes. Without TTS, pass hooks through directly.
    logger.debug(`[MastraAdapter] Generating response for transcript...`);

    const hasTTS = !!voice.speak;
    let accumulatedText = "";

    const streamHooks: StreamHooks = hasTTS
      ? {
          ...hooks,
          onChunk: (text: string) => {
            accumulatedText += text;
            hooks.onChunk(text);
          },
          onFinish: () => {
            // Deferred — will be called after TTS completes (or fails)
          },
        }
      : hooks;

    await this.stream(transcript, streamHooks, options);

    if (hasTTS) {
      try {
        hooks.onStatusUpdate({ status: "GENERATING", customMessage: "Generating audio" });

        const audioStream = await voice.speak!(accumulatedText);
        if (audioStream) {
          const reader = (audioStream as unknown as ReadableStream<Uint8Array>).getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            hooks.onAudioChunk(value);
          }
          hooks.onAudioEnd();
        }
      } catch (error) {
        // TTS is best-effort — the text response was already sent
        logger.warn({ err: error }, "[MastraAdapter] TTS failed (text response already sent)");
      }
      hooks.onFinish();
    }
  }

  getConfig(): MessagingAgentConfig {
    // getInstructions() is sync when instructions are static strings (the common case).
    // Dynamic instruction functions return a Promise and are skipped here since
    // getConfig() is called once at startup for playground display.
    const instructions = this.agent.getInstructions();
    let systemPrompt = "";
    if (typeof instructions === "string") {
      systemPrompt = instructions;
    } else if (Array.isArray(instructions)) {
      systemPrompt = instructions
        .map((i) => (typeof i === "string" ? i : ""))
        .filter(Boolean)
        .join("\n\n");
    }

    // listTools() is sync when tools are static (the common case).
    const tools = this.agent.listTools();
    let toolConfigs: MessagingAgentConfig["tools"] = [];
    if (tools && typeof tools === "object" && !("then" in tools)) {
      toolConfigs = Object.entries(tools).map(([name, tool]) => ({
        name,
        title: name,
        description:
          (tool as { description?: string }).description || "",
        type: "other",
      }));
    }

    return {
      systemPrompt,
      tools: toolConfigs,
      supportsFiles: this.supportsFiles,
    };
  }
}
