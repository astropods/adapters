# Agent auth for self-served HTTP surfaces

## Summary

An agent that serves its own HTTP surface (the "custom interface") had no way to
answer "who is calling, and are they allowed?" without hand-rolling the chain
the messaging container implements in Go: read the front door's OIDC identity
headers, call astro-server's authorize endpoint with the deploy token, cache the
answer, fail closed. Nobody had written that in TypeScript or Python, so
`interfaces.auth.custom.grants` was collected by the deploy form, persisted to
`deployment_authorization_grants`, and then enforced by nothing.

adapter-core now ships that chain in both languages. The endpoint already
accepted `adapter=custom`, so this needs no server change.

## Design

Auth is a second entry point on adapter-core, not a new package:
`@astropods/adapter-core/auth` and `astropods_adapter_core.auth`. Nothing in
`auth/` imports the messaging bridge and nothing outside imports into it, so an
agent serving a UI does not pull a gRPC module graph and an agent calling
`serve()` does not pull an HTTP one. On Node that separation is complete,
because `@astropods/messaging` is already a peer dependency. On Python
`astropods-messaging` and `grpcio` remain hard dependencies of the package, so
an auth-only consumer still installs them; the new crypto dependencies are
behind an `auth` extra rather than widening the base install further.

### Three layers

`Authorizer` is the facade: `identify(headers)` returns a `Principal` or null,
`authorize(principal)` returns a `Decision`. The two stay separate because they
answer different questions, and an agent may want identity without enforcement.
The name is the one the Go interface already uses, so the parity fixtures
compare identically named things across three languages.

`guard()` runs the identify-then-authorize sequence and maps the result onto a
status code. Every framework binding is a thin wrapper over it, which is what
keeps the four outcomes consistent no matter how the agent is served:

| Outcome | Status |
|---|---|
| Allowed | 200, principal attached to the request |
| Grants exclude an identified caller | 403 |
| Grants exclude an anonymous caller | 401 |
| Authorize call could not complete | 503 |

Bindings cover Express/Connect, Fastify, Hono, and any Fetch-API handler on
Node; ASGI (FastAPI, Starlette), WSGI (Flask, Django), and a FastAPI dependency
on Python. All are typed structurally, so the package depends on no framework.

The primitives are exported for anyone wiring something else:
`AlbIdentityVerifier`, `AuthorizeClient`, `DecisionCache`.

### An absent identity is a question for the server, not a local refusal

`guard()` does not refuse a request that arrives without an identity header. It
authorizes it as an anonymous caller and lets the server's `anyone`
short-circuit decide, which is what the Go client already does: empty
`identity_type` and `identity_id` are valid inputs to the endpoint. Refusing
locally would make a public interface unreachable the moment it adopted the
middleware, because `interfaces.auth.custom.public` routes the surface to the
open ingress cohort where no identity header is ever injected.

A public interface needs an `anyone` grant under
`interfaces.auth.custom.grants` to stay reachable. The deploy token's
`anyone_adapters` claim is derived from the grants, not from the `public` flag,
and deploy-time validation does not enforce that pairing for `custom` the way
RFC-2 rule 25 enforces it for `web`. Without such a grant the server denies the
anonymous caller and the guard answers 401.

### Identity comes from the front door, never from a secret in the agent

Two identity sources: `alb`, the WorkOS user id the tenant-router ALB injects
after it performs OIDC, and `fixed` for local dev. The agent never runs an OIDC
flow itself. Doing so would require an OIDC client secret inside a
tenant-controlled container, and the component holding that secret is the ALB by
design.

### One deliberate departure from the messaging container

The SDK verifies the `x-amzn-oidc-data` signature; the messaging container reads
`x-amzn-oidc-identity` as a bare string and verifies nothing. That is defensible
for a first-party pod whose topology we control. It is not defensible for a
library shipped to third parties, because the tenant NetworkPolicy admits
ingress from every same-namespace pod and every IP outside the pod subnet.

Verification reads `kid` and `signer` from the JWT header, fetches the ES256
public key from the regional ELB endpoint, and caches it by `kid`. ALB puts
`exp` in the header rather than the payload, so expiry is checked there.
`verifyIdentity: false` restores container parity and logs a warning at startup.

### Everything else matches the Go implementation

Divergence would produce an agent behaving differently from the chat surface
beside it under the same grants. Preserved: fail closed on transport error;
degraded-mode allow from the `anyone_adapters` claim cached at 10s when the
server is unreachable and the adapter is listed; a 60s decision cache keyed on
`(identity_type, identity_id, adapter, identity_scope)` that caches denials too;
a 5s request timeout; no local signature check on the deploy token, which is
decoded only for `sub` and `iss`. Principal resolution stays entirely
server-side, which is what keeps the client thin enough to maintain twice.

A token missing either claim fails construction, matching Go's `DecodeToken`,
rather than yielding an empty deployment id. An empty `sub` would reach the
endpoint as a malformed credential, and the 401 that came back is classified as
an availability failure, which is the one path that can degrade open under an
`anyone_adapters` claim.

`adapter` defaults to `custom` rather than `web`, since `web` is the messaging
sidecar's own chat surface.

### Parity

`test-data/auth-parity.json` drives both implementations over the same cases:
deploy-token decoding, the guard outcome matrix, and the query the client sends.
A behavior change in one language fails the other's suite until it follows.

## Migration

None. New entry point, nothing existing changes. An agent adopts it by
constructing an `Authorizer` and mounting a binding; `ASTRO_AUTHZ_TOKEN` is
already injected into every agent container, so zero-argument construction works
in a deployed agent. Python consumers installing for auth want
`astropods-adapter-core[auth]`.
