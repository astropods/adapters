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
| Already in memory | The thread's stored `resourceId` |
| New, 1:1 (`eventKind` is `EVENT_KIND_DM` or unset, as for DMs and the web chat) | The user ID |
| New, in a channel (an app mention, thread reply, observed message, or reaction) | The conversation ID |

Nobody owns a channel conversation. Everyone in the thread can already read it, so the conversation is the resource, and no one person's resource-scoped memory (working memory, cross-thread recall) mixes into it. A 1:1 chat keeps the user as its resource, so resource-scoped memory still follows them between chats.

A stored thread keeps its resource. Threads created before this change belong to their first speaker, and they keep working without a migration.

The lookup is one `getThreadById` call per turn, and only when the agent has memory. The request context's `resourceId` stays the sender's user ID, as the README documents for agents' own tools.

## Migration

None. Update `@astropods/adapter-mastra` and redeploy. A `^0.x` range does not take a new minor version, so bump the range by hand.
