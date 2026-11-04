# Keep raw agent errors out of the chat

## Summary

When an agent's turn failed, the bridge sent the exception's text as the error users see. Slack posted it into the thread for everyone:

```
Error: Thread "C0AFQMLMFU3-1793751869.620359" belongs to resource "user_A" but resource "user_B" was provided. A thread can only be used by the resource that owns it. (code: AGENT_ERROR)
```

The text names internal IDs and tells the user nothing they can act on. The messaging protocol already separates the two parts: `ErrorResponse.message` is the user-facing message, and `details` holds technical detail that is logged and never shown.

## Design

`hooks.onError` in TypeScript and `on_error` in Python now send:

| Field | Value |
| --- | --- |
| `code` | `AGENT_ERROR`, unchanged |
| `message` | `AGENT_ERROR_MESSAGE`: "The agent couldn't finish its reply. Try again, and tell the agent's owner if it keeps happening." |
| `details` | The exception text that `message` carried before |

The bridge still logs the full error with the conversation ID, so the agent's logs and traces keep the cause. Slack and the web chat show `message`, so both now show the plain message.

An agent that wants a specific message in front of the user should reply with it, not raise it. An exception's text is treated as internal.

## Migration

None. Update `@astropods/adapter-core` or `astropods-adapter-core` and redeploy. A `^0.x` range does not take a new minor version, so bump the range by hand.
