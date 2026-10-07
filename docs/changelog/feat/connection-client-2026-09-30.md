# A client for the chatting user's connections

## Summary

Agents can now act as the person chatting with them, through that person's own connected account. A user connects GitHub (or another provider) once on Astropods, then allows an agent to use it when they start a chat. This package gives the agent the call that turns that consent into a token. The platform side is `docs/01-spec/agent-connections-spec.md` in `astropods/astro`.

## Design

`@astropods/adapter-core/connections` exports `ConnectionClient`. It has the same shape as `SandboxClient`: it reads `ASTRO_AUTHZ_TOKEN`, takes the server URL from its `iss` claim, and calls one route.

```ts
const connections = new ConnectionClient();
const { accessToken } = await connections.getToken("github", options.userId);
```

- **The agent names the user, and the server decides.** `getToken(provider, userId)` posts `{ user_id, provider }` to `POST /api/v1/deployments/connections/token` with the deploy token. The server returns a token only when that user has consented for this deployment and has messaged it through web chat in the last 15 minutes. The agent can't write either fact, so naming an arbitrary user gets it nothing.
- **Caching follows the token's own expiry.** A token with `expires_at` is reused until a minute before it. A token without one, which is how GitHub OAuth tokens arrive, is fetched on every call, so a revoke or an expired consent stops the agent at its next call rather than at some cache boundary. The cache key includes the user, so one user's token never serves another's turn.
- **Refusals are typed.** `ConnectionError.code` is one of `not_consented`, `not_active`, `not_connected` and `needs_reauthorization`, taken from the server's `error` field. An agent can use it to tell the user what to do. Any other failure, including an unreachable server, is `unavailable`.
- **A turn with no user is refused locally**, without a request.
- **Python has the same client.** `astropods_adapter_core.connections.ConnectionClient` offers `get_token(provider, user_id)` and `get_token_async(provider, user_id)`, which share one cache. The error is `ConnectionTokenError` with the same codes; the name avoids Python's built-in `ConnectionError`. It needs `httpx`, through the new `connections` extra.

## Migration

None. The subpath is new, and nothing changes for agents that don't use it.
