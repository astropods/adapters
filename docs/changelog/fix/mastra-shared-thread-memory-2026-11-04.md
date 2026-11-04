# Let everyone in a Slack thread talk to a Mastra agent with memory

## Summary

A Mastra agent with memory failed on the second person to speak in a Slack thread:

```
Thread "C0AFQMLMFU3-1793751869.620359" belongs to resource "user_A" but resource "user_B" was provided. A thread can only be used by the resource that owns it.
```

The adapter used the conversation as the memory thread and each turn's sender as the memory resource. Mastra binds a thread to the resource that created it and rejects any other (`assertThreadOwnedByResource`, `AGENT_MEMORY_THREAD_RESOURCE_MISMATCH`). So whoever spoke first in a thread owned it, and nobody else could use it. An agent without memory never hit this, because Mastra checks ownership only when memory is configured.

## Design

`MastraAdapter` resolves the memory resource once per turn, before the edit replay and the stream. Both use the same value:

| Conversation | Memory resource |
| --- | --- |
| 1:1 (`eventKind` is `EVENT_KIND_DM` or unset, as for DMs and the web chat) | The user ID |
| In a channel (an app mention, thread reply, or observed message) | The conversation ID |
| Another kind, such as a reaction | The conversation ID for a new thread, or the stored thread's resource |

Nobody owns a channel conversation. Everyone in the thread can already read it, so the conversation is the resource, and no one person's resource-scoped memory (working memory, cross-thread recall) mixes into it. A 1:1 chat keeps the user as its resource, so resource-scoped memory still follows them between chats.

A channel thread created before this change belongs to its first speaker. Keeping that owner would give everyone in the thread the first speaker's resource-scoped memory. So the first channel turn on such a thread moves it under the conversation: the adapter waits for pending memory writes, recalls the thread's messages, re-saves them with the new `resourceId`, and re-saves the thread. Mastra's stores upsert both by ID (LibSQL uses `INSERT OR REPLACE` for threads and `ON CONFLICT(id) DO UPDATE` for messages), so the history survives the move. No separate migration runs.

Any other stored thread keeps its resource, because Mastra rejects a thread used with a different one.

The lookup is one `getThreadById` call per turn, and only when the agent has memory. The move happens at most once per old channel thread. The request context's `resourceId` stays the sender's user ID, as the README documents for agents' own tools.

## Migration

None. Update `@astropods/adapter-mastra` and redeploy. A `^0.x` range does not take a new minor version, so bump the range by hand.
