import { MemorySaver } from "@langchain/langgraph-checkpoint";

/**
 * Ensure the agent persists conversation state across turns.
 *
 * The adapter streams only the latest user message keyed by `thread_id`, so
 * LangGraph reconstructs history from its checkpointer. `createAgent` and
 * `createReactAgent` default to no checkpointer, which would make every turn
 * start fresh. When none is configured we install an in-process `MemorySaver`
 * so multi-turn chat works out of the box.
 *
 * A checkpointer the caller already configured (in-memory or durable) is left
 * untouched. Returns `true` when a `MemorySaver` was installed.
 */
export function ensureCheckpointer(agent: unknown): boolean {
  try {
    // Both a ReactAgent (accessor) and a compiled graph expose `checkpointer`.
    const target = agent as { checkpointer?: unknown };
    if (
      target &&
      typeof target === "object" &&
      "checkpointer" in target &&
      !target.checkpointer
    ) {
      target.checkpointer = new MemorySaver();
      return true;
    }
  } catch {
    // Non-standard agent or a read-only checkpointer accessor — leave it as the
    // caller built it rather than fail serving.
  }
  return false;
}
