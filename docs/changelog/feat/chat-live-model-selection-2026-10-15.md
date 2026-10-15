# Model picked in chat

## Summary

A deployment whose model entries set `selection: live` lets a chat user pick a model for each message, from the gateway or from the builder's own provider keys. The messaging sidecar sends the pick as `Message.model`, and an agent needs it in the place its framework resolves the model for a run. This passes the pick from the message to that place.

## Design

**Core.** The bridge copies `Message.model` onto `StreamOptions.model` as `{ entry, model }`. It reads the field through the local wire type, as it does for `history`, so it builds against an SDK that predates the field. Against such an SDK the field never arrives and `model` stays undefined. `ModelChoice` is exported from core. The Python core does the same: `StreamOptions.model` is an `Optional[ModelChoice]`, last in the dataclass so positional construction keeps working, and the bridge checks the stubs' descriptor before it reads `Message.model`.

**Framework adapters.**

| Adapter | Where the agent reads it |
|---|---|
| Mastra | `requestContext.get("model")`, beside `threadId`, `resourceId`, and `userName` |
| AI SDK | `StreamOptions.model` in the `callOptions` mapper, returned as the model from `prepareCall` |
| LangChain (JS and Python) | `configurable.model` (the model id) and `configurable.model_entry`, beside `thread_id` and `user_name` |

A Mastra agent resolves its model from the request context:

```ts
model: ({ requestContext }) =>
  gateway.chat(
    requestContext.get<"model", ModelChoice | undefined>("model")?.model ?? process.env.MODEL_DEFAULT ?? "claude-sonnet-4-6",
  ),
```

Mastra does not keep a run's request context when the run suspends. The Mastra adapter therefore passes the turn's request context to `approveToolCall`, `declineToolCall`, and `resumeStream`. A resumed run answers with the same model, and it also gets `threadId`, `resourceId`, and `userName` again. `@astropods/adapter-mastra` re-exports `ModelChoice`.

LangChain's `init_chat_model` (`initChatModel` in TypeScript) reads `configurable.model` when `model` is one of its configurable fields, so the id goes there unchanged. The entry goes in its own key. The Python adapter reads `model` with `getattr`, so it still runs against an older `astropods-adapter-core` and sends no model.

The AI SDK adapter needs no change: `callOptions` already receives the whole `StreamOptions`. Its README shows the `prepareCall` pattern, and the test "lets a ToolLoopAgent's prepareCall answer with the chosen model" (`packages/ai-sdk/src/adapter.test.ts`) checks it against a real `ToolLoopAgent`.

## Migration

None. Each field is optional. An agent sees a model once the deployment lists live models and its messaging sidecar and SDK carry the field. Until then the agent keeps the model chosen at deploy.
