import type { ModelMessage } from "ai";

export interface HistoryLimits {
  maxTurns: number;
  maxHistoryBytes: number;
  maxConversations: number;
}

interface Turn {
  messages: ModelMessage[];
  bytes: number;
  compacted: boolean;
}

/** Each conversation's model messages, held in process as whole turns. */
export class ConversationHistory {
  // Map insertion order is least recently used first.
  private readonly conversations = new Map<string, Turn[]>();

  constructor(private readonly limits: HistoryLimits) {
    for (const [name, value] of Object.entries(limits)) {
      if (!Number.isInteger(value) || value < 0) {
        throw new RangeError(`${name} must be a non-negative integer, got ${value}`);
      }
    }
  }

  get enabled(): boolean {
    return Object.values(this.limits).every((value) => value > 0);
  }

  messages(conversationId: string): ModelMessage[] {
    return (this.conversations.get(conversationId) ?? []).flatMap((t) => t.messages);
  }

  /** Appends a completed turn to what the conversation holds now, not to what the turn started from. */
  append(conversationId: string, messages: ModelMessage[]): void {
    if (!this.enabled) return;
    const turn = toTurn(withoutUnansweredToolCalls(messages));
    this.store(conversationId, this.trim([...(this.conversations.get(conversationId) ?? []), turn]));
  }

  /** Drops the older half of a conversation after a failed turn, down to nothing on repeated failures. */
  shrink(conversationId: string): void {
    const turns = this.conversations.get(conversationId);
    if (turns) this.store(conversationId, turns.slice(Math.ceil(turns.length / 2)));
  }

  private trim(turns: Turn[]): Turn[] {
    let kept = turns.slice(-this.limits.maxTurns);
    let bytes = kept.reduce((sum, t) => sum + t.bytes, 0);
    for (let i = 0; i < kept.length && bytes > this.limits.maxHistoryBytes; i++) {
      if (kept[i].compacted) continue;
      const compacted = toTurn(withoutToolOutputs(kept[i].messages), true);
      bytes += compacted.bytes - kept[i].bytes;
      kept[i] = compacted;
    }
    while (kept.length > 1 && bytes > this.limits.maxHistoryBytes) {
      bytes -= kept[0].bytes;
      kept = kept.slice(1);
    }
    return kept;
  }

  private store(conversationId: string, turns: Turn[]): void {
    this.conversations.delete(conversationId);
    this.conversations.set(conversationId, turns);
    for (const oldest of this.conversations.keys()) {
      if (this.conversations.size <= this.limits.maxConversations) break;
      this.conversations.delete(oldest);
    }
  }
}

function toTurn(messages: ModelMessage[], compacted = false): Turn {
  return { messages, bytes: Buffer.byteLength(JSON.stringify(messages)), compacted };
}

type Part = { type: string; toolCallId?: string; output?: unknown };

function parts(message: ModelMessage): Part[] {
  return Array.isArray(message.content) ? (message.content as Part[]) : [];
}

/** Removes tool calls the turn never answered: a tool without `execute`, or one awaiting approval. */
function withoutUnansweredToolCalls(messages: ModelMessage[]): ModelMessage[] {
  const answered = new Set(
    messages.flatMap(parts).filter((p) => p.type === "tool-result").map((p) => p.toolCallId)
  );
  return messages.flatMap((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return [message];
    const content = parts(message).filter(
      (p) =>
        p.type !== "tool-approval-request" &&
        (p.type !== "tool-call" || answered.has(p.toolCallId))
    );
    return content.length > 0 ? [{ ...message, content } as ModelMessage] : [];
  });
}

/** Replaces each tool output with a note of its size, keeping calls and results paired. */
function withoutToolOutputs(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    const content = parts(message).map((p) =>
      p.type === "tool-result"
        ? { ...p, output: { type: "text", value: `[${Buffer.byteLength(JSON.stringify(p.output))} bytes of tool output dropped from history]` } }
        : p
    );
    return { ...message, content } as ModelMessage;
  });
}
