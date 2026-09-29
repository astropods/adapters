# AI SDK adapter: conversation history

## Summary

`AISDKAdapter` called `agent.stream({ prompt })` with only the new message and ignored the conversation ID. An agent served through it forgot every earlier turn, so a follow-up such as "and the second one?" reached the model with no context. It also ignored the stop signal, so the stop button in chat did not halt the model call.

## Design

The adapter keeps each conversation's history in process, keyed by the messaging `conversationId`, and sends it as `messages`:

```ts
agent.stream({ messages: [...earlierTurns, { role: "user", content: prompt }], abortSignal: options.signal });
```

After the stream ends, the turn's response messages from `result.response` join the history. The history is stored as whole turns and trimmed from the oldest turn past `maxTurns` (default 20), so a tool call is never kept without its result. A turn that ends in an `error` part is not kept, so a failed call does not leave a dangling user message.

History lives in the process. It resets when the agent restarts and is not shared across replicas.

## Migration

None. Agents served with `serve()` now remember earlier turns. Pass `maxTurns` to change how much history each conversation keeps.
