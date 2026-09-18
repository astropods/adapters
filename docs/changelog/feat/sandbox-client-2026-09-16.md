# Sandbox client

## Summary

Agents can attach a sandbox and run commands in it, but nothing in the SDK
spoke to that API. Every agent would have to decode its own deploy token, find
the control plane, carry three credentials it must not interpret, and re-attach
when they expire. That is the same code in every agent, written slightly
differently each time.

This adds `SandboxClient` to `@astropods/adapter-core`, so an agent attaches a
sandbox by name and runs commands in it.

## Design

```ts
const sandboxes = new SandboxClient();
const result = await sandboxes.exec("conv-42", { command: ["/bin/ls", "/tmp"] });
```

Nothing configures the client. It reads `ASTRO_AUTHZ_TOKEN` from the
environment and takes the control plane's base URL from that token's `iss`
claim, so there is no second env var to keep in step with the first.

`attach` resolves a name to a running sandbox, creating one on the first call
and reusing it after. It is safe on every turn: the server settles concurrent
first calls onto one sandbox. `exec` attaches first when it holds no handle,
which makes `attach` optional for callers that only want to run something.

The transport stays inside the client. A handle carries an endpoint and an
opaque header map, and the client merges every header into each data-plane
request without reading them, because which headers appear is a property of
the runtime the sandbox landed on. Replacing the wire format later changes
this file and no agent code.

Credentials are short-lived and a sandbox past its duration ceiling is
replaced, so a refused data-plane request is ordinary rather than fatal. `exec`
re-attaches once on 401, 403, or an unreachable endpoint, then gives up instead
of looping.

A failed request reports the status it failed with, and the response body when
that body is not the control plane's own JSON error. Anything between the agent
and the control plane can answer instead of it, and a CDN or proxy answers with
HTML. Without the raw body the caller only learns that the call failed, which
is not enough to tell a blocked edge apart from a refused token.

A non-zero exit code and a timed-out command are results, not errors. Only the
call itself failing throws.

## Migration

None. New API, no existing behavior changes.
