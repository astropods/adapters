import type { Agent } from "@mastra/core/agent";
import type {
  AgentConfig as MessagingAgentConfig,
} from "@astropods/messaging";
import type { AgentAdapter, AudioInput, StreamHooks, StreamOptions } from "@astropods/adapter-core";

function debug(...args: unknown[]) {
  if (process.env.DEBUG) console.debug(...args);
}

/**
 * Adapts a Mastra Agent to the Astro messaging protocol.
 *
 * Translates Mastra's fullStream chunk types into the StreamHooks lifecycle
 * that the MessagingBridge expects.
 */
export class MastraAdapter implements AgentAdapter {
  readonly name: string;

  constructor(private agent: Agent) {
    this.name = agent.name;
  }

  async stream(
    prompt: string,
    hooks: StreamHooks,
    options: StreamOptions
  ): Promise<void> {
    const stream = await this.agent.stream(prompt, {
      memory: {
        thread: options.conversationId,
        resource: options.userId,
      },
    });

    // Track tool names by call ID so we can reference them when the call ends
    // (the end chunk only carries toolCallId, not toolName).
    const toolNames = new Map<string, string>();

    for await (const chunk of stream.fullStream) {
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

        case "finish": {
          const traceId = (stream as unknown as { traceId?: string }).traceId;
          if (traceId) hooks.onTraceId?.(traceId);
          hooks.onFinish();
          break;
        }

        case "error":
          hooks.onError(
            chunk.payload.error instanceof Error
              ? chunk.payload.error
              : new Error(String(chunk.payload.error))
          );
          break;
      }
    }
  }

  async streamAudio(
    audio: AudioInput,
    hooks: StreamHooks,
    options: StreamOptions
  ): Promise<void> {
    const voice = this.agent.voice;
    if (!voice) {
      console.error("[MastraAdapter] streamAudio called but agent has no voice provider");
      hooks.onError(new Error("Agent has no voice provider configured"));
      return;
    }

    debug(`[MastraAdapter] streamAudio: encoding=${audio.config.encoding} filetype=${audio.filetype} conversation=${options.conversationId}`);

    // STT: transcribe audio to text
    hooks.onStatusUpdate({ status: "PROCESSING", customMessage: "Transcribing audio" });

    let transcript: string;
    try {
      debug("[MastraAdapter] Calling voice.listen() for STT...");
      const result = await voice.listen(audio.stream, {
        filetype: audio.filetype,
      });
      transcript = typeof result === "string" ? result : String(result ?? "");
      debug(`[MastraAdapter] STT result: "${transcript.substring(0, 100)}${transcript.length > 100 ? "..." : ""}"`);

      // Send transcript back to update the placeholder user message
      hooks.onTranscript(transcript);
    } catch (error) {
      console.error("[MastraAdapter] STT failed:", error);
      hooks.onError(
        error instanceof Error ? error : new Error(String(error))
      );
      return;
    }

    if (!transcript.trim()) {
      console.warn("[MastraAdapter] STT returned empty transcript");
      hooks.onError(new Error("Could not transcribe audio"));
      return;
    }

    // Generate a text response using the transcript as the prompt.
    // When TTS is available, intercept chunks to accumulate text and defer
    // onFinish until after TTS completes. Without TTS, pass hooks through directly.
    debug(`[MastraAdapter] Generating response for transcript...`);

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
        console.warn("[MastraAdapter] TTS failed (text response already sent):", error);
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
    };
  }
}
