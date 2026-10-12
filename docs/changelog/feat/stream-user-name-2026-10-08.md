# Sender name for every adapter

Closes astropods/astro#3126

## Summary

An agent could not greet or address the person it was answering by name. `StreamOptions` carried `userId`, which is the linked Astro user ID for a linked Slack user, and `platformContext`, which holds the raw Slack ID but no name. The bridge dropped `Message.user.username` on the way in, and the framework adapters passed no per-user context to the agent beyond the id.

## Design

**Core.** The bridge copies `Message.user.username` onto `StreamOptions`, as `userName` in TypeScript and `user_name` in Python. The messaging sidecar fills that field: from Slack's `users.info` for Slack (astropods/messaging#99), and from the signed-in Astro user for web chat.

| | TypeScript | Python |
|---|---|---|
| Field | `userName?: string` | `user_name: str = ""` |
| No name sent | `undefined` | `""` |

The Python field is last in the dataclass, so code that builds `StreamOptions` positionally keeps working. Only the text-message path carries a name. Audio turns start from `AudioStreamConfig`, which has no user name.

**Framework adapters.** Each adapter hands the name to the agent through its framework's own per-run context, so agent code reads it the way it reads anything else per run.

| Adapter | Where the agent reads it |
|---|---|
| Mastra | `requestContext.get("userName")`, beside `threadId` and `resourceId` |
| LangChain (JS and Python) | `configurable.user_name`, beside `thread_id` |
| AI SDK | The agent's call options, through a new `callOptions` mapper |
| Claude Agent SDK | `options.userName` in the builder's own `stream()`, since this package only instruments the SDK |

Each adapter leaves the key out when no name was sent, rather than setting it empty.

The AI SDK has no general per-call context: an `Agent` takes per-call data only as call options, typed by its `callOptionsSchema`. `AISDKAdapter` and `serve()` gained a `CALL_OPTIONS` type parameter and a `callOptions: (options: StreamOptions) => CALL_OPTIONS` option. The adapter passes its result as the agent's `options`, and the agent's `prepareCall` reads it. An agent without call options is unchanged, and no `options` key is sent.

The LangChain Python adapter reads `user_name` with `getattr`, so it still runs against an `astropods-adapter-core` older than the release that adds the field, and sends no name. Its core floor stays at `>=0.6.0`: release-please sets the next core version at release time, so a floor naming it cannot resolve in CI, which installs core from the checkout.

## Migration

None. Every field and option is optional. Agents see a name once their messaging sidecar runs a build that sets it; until then the field is empty.
