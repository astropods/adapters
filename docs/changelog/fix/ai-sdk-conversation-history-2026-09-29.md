# AI SDK adapter: conversation history

## Summary

`AISDKAdapter` called `agent.stream({ prompt })` with only the new message and ignored the conversation ID. An agent served through it forgot every earlier turn, so a follow-up such as "and the second one?" reached the model with no context. It also ignored the stop signal, so the stop button in chat did not halt the model call.

## Design

The adapter keeps each conversation's history in process, keyed by the messaging `conversationId`. It sends the history as `messages` and forwards the stop signal:

```ts
agent.stream({ messages: [...history, { role: "user", content: prompt }], abortSignal: options.signal });
```

After a turn completes, the adapter appends every step's messages to the history. On ai 7 it reads `result.responseMessages`, because the deprecated `response.messages` holds only the last step and would lose the turn's tool calls and results. On ai 6 it reads `response.messages`, which holds every step there.

Each rule below keeps the stored history valid for the next model call:

- **Unanswered tool calls.** A tool without `execute`, or one awaiting approval, ends a turn on a tool call with no result. A provider rejects any request that still carries it, so the adapter drops it before storing the turn.
- **Size.** Past `maxHistoryBytes`, the adapter replaces the oldest tool outputs with a note of their size, then drops the oldest turns. The newest turn stays. One fetched page therefore no longer erases the questions before it.
- **Failures.** A turn that ends in an `error` part drops the older half of that conversation's history. Stored history can cause the failure, for example past a small model's context window. Halving on each failure means the conversation recovers instead of failing on every follow-up.
- **Stops.** A stopped turn stores nothing and shrinks nothing.
- **Overlap.** A finished turn appends to the history as it is when the turn finishes. Two overlapping turns in one conversation are both kept.
- **Empty IDs.** A turn with an empty conversation ID uses no history, so such turns never share one.

Three options bound the size, each a non-negative integer. The constructor rejects any other value:

| Option | Default | Bounds |
| --- | --- | --- |
| `maxTurns` | 20 | Turns per conversation. `0` turns history off. |
| `maxHistoryBytes` | 256 KiB | Serialized history per conversation, about 64K tokens |
| `maxConversations` | 200 | Conversations held, least recently used forgotten first |

At the defaults, history takes at most about 50 MB. That is about 5% of an agent container's default 1 GiB limit (`StandardResources` in astro-server's `internal/deployment/deployment_spec.go`).

History lives in the process. It resets when the agent restarts, and each replica keeps its own. The messaging sidecar's saved copy of the chat is separate and untouched.

## Migration

Agents served with `serve()` now receive `messages` instead of `prompt`. Pass `memory: false` to keep the earlier behavior. An agent needs it when its `prepareCall` reads `prompt`, or when it keeps its own memory, so the model does not see the context twice. Pass `maxTurns`, `maxHistoryBytes` or `maxConversations` to change the limits.
