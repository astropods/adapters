# Model picked in chat

## Summary

An agent can let a chat user pick a model for each message. The agent declares the models it accepts, the messaging sidecar (astropods/messaging) shows them in the web chat's model picker, and it sends the pick as `Message.model`. The adapters take the list as an option and hand the pick to the place each framework resolves a run's model.

## Design

**Declaring the list.** Every adapter takes `models`, a list of model ids, the first being the default, and reports it from `getConfig()` (`get_config()` in Python). The bridge sends it as `AgentConfig.models`. With two or more, the chat shows a picker.

**Receiving the pick.** The bridge copies `Message.model` onto `StreamOptions.model`, the picked id. It is undefined (`""` in Python) when no model was picked, as on a Slack turn, so the agent keeps its default. The TypeScript bridge reads the field through its local wire type, and the Python bridge checks the stubs' descriptor first, so both run against an SDK older than 0.4.0, where the field never arrives.

| Adapter | Where the agent reads the pick |
|---|---|
| Mastra | `requestContext.get("model")`, beside `threadId`, `resourceId`, and `userName` |
| AI SDK | `StreamOptions.model` in the `callOptions` mapper, returned as the model from `prepareCall` |
| LangChain (JS and Python) | `configurable.model`, beside `thread_id` and `user_name` |
| Claude Agent SDK | `options.model` in the builder's own `stream()` |

```ts
const MODELS = ["claude-sonnet-4-6", "claude-opus-4-7"];

const agent = new Agent({
  // ...
  model: ({ requestContext }) =>
    gateway.chat(requestContext.get<"model", string | undefined>("model") ?? MODELS[0]),
});

serve(agent, { models: MODELS });
```

Mastra does not keep a run's request context when the run suspends. The Mastra adapter therefore passes the turn's request context to `approveToolCall`, `declineToolCall`, and `resumeStream`. A resumed run answers with the same model, and it also gets `threadId`, `resourceId`, and `userName` again.

LangChain's `init_chat_model` (`initChatModel` in TypeScript) reads `configurable.model` when `model` is one of its configurable fields, so the id goes there unchanged.

## Migration

None. Each field is optional. An agent opts in by passing `models` and resolving its model from the pick. It sees a pick once its messaging sidecar and SDK carry the field.
