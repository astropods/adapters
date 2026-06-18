/**
 * Ensure the agent persists conversation state across turns.
 *
 * The adapter streams only the latest user message keyed by `thread_id`, so
 * LangGraph reconstructs history from its checkpointer. `createAgent` and
 * `createReactAgent` default to no checkpointer, which would make every turn
 * start fresh. When none is configured we install an in-process `MemorySaver`
 * so multi-turn chat works out of the box.
 *
 * Only a nullish value counts as "unset": a checkpointer the caller configured
 * and an explicit `checkpointer: false` opt-out are both left untouched. The
 * checkpoint package is imported lazily so the adapter still imports without it
 * (e.g. when only `instrumentLangChain()` is used). Returns `true` when a
 * `MemorySaver` was installed.
 */
export async function ensureCheckpointer(agent: unknown): Promise<boolean> {
  try {
    // Both a ReactAgent (accessor) and a compiled graph expose `checkpointer`.
    const target = agent as { checkpointer?: unknown };
    if (
      !target ||
      typeof target !== "object" ||
      !("checkpointer" in target) ||
      target.checkpointer != null
    ) {
      return false;
    }

    const { MemorySaver } = await import("@langchain/langgraph-checkpoint");
    target.checkpointer = new MemorySaver();
    return true;
  } catch {
    // Checkpoint package absent, or a read-only checkpointer accessor — serve
    // without persistence rather than fail.
    return false;
  }
}
