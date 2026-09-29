# AI SDK adapter: conversation history

## Summary

`AISDKAdapter` called `agent.stream({ prompt })` with only the new message and ignored the conversation ID. An agent served through it forgot every earlier turn, so a follow-up such as "and the second one?" reached the model with no context. It also ignored the stop signal, so the stop button in chat did not halt the model call.

## Design

The adapter keeps each conversation's history in process, keyed by the messaging `conversationId`, and sends it as `messages`:

```ts
agent.stream({ messages: [...earlierTurns, { role: "user", content: prompt }], abortSignal: options.signal });
```

After the stream ends, the turn's response messages from `result.response` join the history. The history is stored as whole turns, so a tool call is never kept without its result. A turn that ends in an `error` part is not kept, so a failed call does not leave a dangling user message.

Three limits bound it:

| Option | Default | Bounds |
| --- | --- | --- |
| `maxTurns` | 20 | Turns per conversation |
| `maxHistoryBytes` | 256 KiB | Serialized history per conversation, about 64K tokens |
| `maxConversations` | 200 | Conversations held, least recently used forgotten first |

The byte limit matters as much as the turn limit. One tool turn can carry a 100 KB page, so 20 turns can outgrow a 128K-token context. Without it, every follow-up in that conversation would fail, and because a failed turn is not kept, the conversation would never recover. The conversation limit keeps memory flat for a long-running agent: at the defaults, history takes at most about 50 MB, about 5% of the default 1 GiB agent container.

History lives in the process. It resets when the agent restarts and is not shared across replicas. The saved chat in the messaging sidecar's store is separate and untouched.

## Migration

None. Agents served with `serve()` now remember earlier turns. Pass `maxTurns`, `maxHistoryBytes` or `maxConversations` to `serve()` to change the limits.
