# Agent auth SDK spec

**Status:** Proposed
**Date:** 2026-09-10
**Scope:** `packages/core` and `packages/core-py`. One doc-truth follow-up in `astropods/astro`.

## Summary

An agent that serves its own HTTP surface (the "custom interface") has no way to
answer "who is calling, and are they allowed?" without hand-rolling the chain the
messaging container already implements in Go. This spec adds that chain to
adapter-core, in both languages: read the front-door OIDC identity, call
`GET /api/v1/deployments/authorize`, cache, and fail closed.

The endpoint already accepts `adapter=custom`
(`apps/astro-server/handlers/authorization.go`). No server change is required to
ship the SDK.

## Why this is missing today

`interfaces.auth.custom.grants` is captured in the deploy form, validated, and
persisted to `deployment_authorization_grants` with `adapter='custom'`. Nothing
enforces it. Two places say so:

| Source | Claim |
|---|---|
| `apps/astro-server/internal/deployment/deployment_spec.go` (`DeploymentCustomAuth.Grants`) | "NOT enforced by the platform today, the agent's own server is responsible for authorization" |
| `docs/00-RFC/RFC-2-deployment-spec.md` §13 rule 25 | "`interfaces.auth.custom`, whose grants aren't enforced by the platform at all" |

`docs/changelog/feat/custom-interface-grant-access-2026-06-26.md` names the
intended fix as an ext_authz hop in front of the agent ingress. That change is
owned by infra and is not the only answer: the agent's own process can enforce
the same grants against the same endpoint, today, in-process. The SDK is that
path. The two are complementary, not competing, because both terminate at the
same authorize call.

## What the messaging container does

The SDK reproduces this chain. Numbers are the current Go behavior.

| Step | Mechanism | Source |
|---|---|---|
| 1. Front door | ALB listener rule priority 100 on `*.agents.<domain>` runs `authenticate-oidc` against WorkOS. `*.agents.public.<domain>` falls through to the no-auth default action. | `modules/astro-infra/docs/architecture/14-tenant-router.md` |
| 2. Identity headers | ALB injects `x-amzn-oidc-identity` (WorkOS user id), `x-amzn-oidc-data` (signed claims JWT), `x-amzn-oidc-accesstoken`. | same |
| 3. Session | Container reads `x-amzn-oidc-identity` as the user id. It does not verify `x-amzn-oidc-data`. | `modules/messaging/internal/adapter/web/session.go` |
| 4. Credential | `ASTRO_AUTHZ_TOKEN`, an HS256 JWT signed by astro-server. `sub` is the deployment id, `iss` is astro-server's base URL, `anyone_adapters` lists open adapters at issue time. | `apps/astro-server/internal/deploytoken/token.go` |
| 5. Authorize | `GET {iss}/api/v1/deployments/authorize?identity_type=user&identity_id=<sub>&adapter=web`, `Authorization: Bearer <token>`. | `modules/messaging/internal/authz/client.go` |
| 6. Resolution | Server resolves the principal to candidates (user id plus every account they belong to, plus audiences), checks `anyone`, checks grants, applies the no-grants owner fallback. | `handlers/authorization.go`, `internal/authorizationstore` |
| 7. Cache | 60s TTL keyed on `(identity_type, identity_id, adapter, identity_scope)`. Allow and deny both cached. | `internal/authz/cache.go` |
| 8. Failure | Transport error and no `anyone_adapters` entry: deny, do not cache, return 503. With an entry: allow, cache 10s. | `internal/authz/authz.go` |
| 9. Dev | No `ASTRO_AUTHZ_TOKEN`: allow all, echo the identity back. | `cmd/server/main.go` |

The agent container already receives `ASTRO_AUTHZ_TOKEN`
(`internal/deployment/resolve.go`, `RoleAgent`), so an agent has every input it
needs. Only the code is missing.

## Placement

Auth ships inside adapter-core, as a second entry point alongside the existing
`./instrument` one. No new package.

| Package | Entry point | Import |
|---|---|---|
| `@astropods/adapter-core` | `packages/core/src/auth/` | `@astropods/adapter-core/auth` |
| `astropods-adapter-core` | `packages/core-py/src/astropods_adapter_core/auth/` | `astropods_adapter_core.auth` |

A separate entry point, not a re-export from the root. An agent that serves a
custom UI may never call `serve()`, and an agent that calls `serve()` never sees
an HTTP request, so neither side should pull the other's module graph. The root
index stays as it is; nothing in `auth/` imports from `messaging-bridge.ts`,
`serve.ts`, or their Python equivalents, and nothing outside `auth/` imports
into it.

Dependencies stay proportionate:

- **Node.** `@astropods/messaging` is already a peer dependency, not a hard one,
  so importing `@astropods/adapter-core/auth` pulls no gRPC. Add `jose` for JWT
  verification and JWKS caching.
- **Python.** `astropods-messaging` and `grpcio` are hard dependencies of
  `astropods-adapter-core`, so an auth-only consumer installs them even though
  nothing in `auth/` imports them. That is the real cost of the single-package
  shape, and it is an install-size cost, not a runtime import cost. Keep the new
  crypto dependencies behind an `auth` extra (`astropods-adapter-core[auth]`)
  rather than widening the base install further.

## Surface

Three layers. Most users touch only the second.

### 1. Core

Transport-agnostic. Takes a header map, returns a decision. Everything else in
the SDK is built on this.

```ts
import { Authorizer } from "@astropods/adapter-core/auth";

const authz = new Authorizer();            // reads env; zero-arg works in-cluster
const principal = await authz.identify(headers);    // Principal | null
const decision = await authz.authorize(principal);  // { allowed, userId }
```

```python
from astropods_adapter_core.auth import Authorizer

authz = Authorizer()
principal = await authz.identify(headers)
decision = await authz.authorize(principal)
```

`Authorizer` is the name the Go interface this ports already uses
(`modules/messaging/internal/authz/authz.go`). Keeping it means the parity
fixtures compare identically named things in three languages, and it avoids
stuttering against a module path that already says both "astro" and "auth".

`Principal` carries `userId`, `email`, `name`, `source` (`alb` | `fixed`), and
the raw verified claims. `identify` returns `null` when no identity is present,
which the caller renders as 401. The two calls stay separate because they answer
different questions: `identify` is authentication, `authorize` is authorization,
and an agent may want the first without enforcing the second.

### 2. Framework bindings

One guard line per framework, matching how `authenticate()` centralizes the
check in the messaging container so a new route cannot forget it.

| Language | Bindings |
|---|---|
| Node | Express/Connect, Fastify, Hono, Next.js route handler, plain `node:http` |
| Python | ASGI middleware (covers FastAPI, Starlette), WSGI middleware (covers Flask, Django), FastAPI `Depends` |

Each binding maps outcomes to status codes identically: no identity 401, denied
403, authorize unreachable and not degraded-allowed 503.

### 3. Primitives

Exported for anyone wiring a framework the SDK does not cover, or supplying
their own identity: `AlbIdentityVerifier`, `AuthorizeClient`, `DecisionCache`.

## Identity sources

Two sources, one authorization path. `authorize()` does not care which source
produced the user id.

| Source | Selected when | Yields |
|---|---|---|
| `alb` | `x-amzn-oidc-data` present | WorkOS user id, verified |
| `fixed` | `ASTRO_AUTHZ_TOKEN` absent (local dev), or explicitly configured | Configured user id, or allow-all |

## Departures from the messaging container

Two deliberate ones. Both are stated here because the SDK is otherwise a port,
and an unexplained difference reads as a bug.

**The SDK verifies `x-amzn-oidc-data`; the messaging container does not.** The
container trusts `x-amzn-oidc-identity` as a bare string. That is defensible for
a first-party pod whose topology we control, and the code says so. It is not
defensible for a library handed to third parties: the tenant NetworkPolicy
(`spec_applier.go`, `allow-namespace-traffic`) admits ingress from every
same-namespace pod and from every IP outside the pod subnet, so a spoofed header
is not a theoretical concern for an agent that also exposes a service elsewhere.
The SDK parses `x-amzn-oidc-data`, reads `kid` and `signer` from the header,
fetches the ES256 public key from
`https://public-keys.auth.elb.<region>.amazonaws.com/<kid>`, caches by `kid`,
and checks `exp`. Verification is on by default when the header is present.
`verifyIdentity: false` restores container parity for anyone who needs it, and
logs a warning once at startup.

**The SDK defaults `adapter` to `custom`, not `web`.** `web` is the messaging
sidecar's own chat surface. An agent serving its own UI is `custom` by
definition, and the grants it should honor are the ones the deploy form wrote
under `auth.custom`.

## Preserved behavior

Everything else matches, because divergence here would produce an agent that
behaves differently from the chat surface next to it under the same grants.

- Fail closed on transport error.
- Degraded-mode allow from the `anyone_adapters` claim, cached at 10s, when the
  server is unreachable and the adapter is listed.
- 60s decision cache on `(identity_type, identity_id, adapter, identity_scope)`,
  caching denials as well as allows.
- 5s per-request timeout.
- No local signature check on `ASTRO_AUTHZ_TOKEN`. The SDK decodes it for `sub`
  and `iss` only. The server is the authority on every call.
- `identity_scope` empty for `custom`. It exists for Slack team disambiguation
  and has no meaning on a web-shaped adapter.

Principal resolution stays entirely server-side. Accounts, audiences, the
Slack identity mapping, and the transitional owner fallback all live in
`handlers/authorization.go`. The SDK never reimplements any of it, which is what
keeps it thin enough to maintain in two languages.

## Configuration

Zero-argument construction works in a deployed agent. Every value has an env
source.

| Env | Meaning | Default |
|---|---|---|
| `ASTRO_AUTHZ_TOKEN` | Deploy token. Supplies the credential, the deployment id (`sub`), and the server URL (`iss`). | none; absent means dev mode |
| `ASTRO_AUTH_ADAPTER` | Adapter to authorize against. | `custom` |
| `ASTRO_AUTH_CACHE_TTL` | Decision cache TTL, seconds. | `60` |
| `ASTRO_AUTH_TIMEOUT` | Per-request timeout, seconds. | `5` |
| `ASTRO_AUTH_DEV_USER_ID` | Fixed identity in dev mode. | none |
| `AWS_REGION` | Region for the ALB public key endpoint. | read from the `signer` ARN when absent |

Dev mode is loud. When `ASTRO_AUTHZ_TOKEN` is absent the SDK allows every
request and logs a warning at startup naming the reason, matching
`cmd/server/main.go`. It never silently allows in a configured deployment: a
present-but-undecodable token is a startup error, not a downgrade.

## Testing

| Layer | Approach |
|---|---|
| Core | Unit, stubbed transport. Table-driven over the decision matrix: allowed, denied, no identity, transport error with and without `anyone_adapters`, cache hit, cache expiry, degraded TTL. |
| ALB verification | Fixture JWTs signed with a known ES256 key, stubbed key endpoint. Covers wrong `kid`, expired, tampered payload, absent header. |
| Bindings | One integration test per framework asserting the status-code mapping. |
| Cross-language parity | A shared JSON fixture set driving both packages, mirroring `sdk/node/src/cross-language.test.ts` in the messaging repo. This is the only thing that keeps two implementations honest over time. |

The Go behavior in `modules/messaging/internal/authz/authz_test.go` and
`cache_test.go` is the reference for the decision matrix. Port those cases
before adding new ones.

## Non-goals

| Not in scope | Why |
|---|---|
| Replacing ALB OIDC | The front door keeps doing OIDC. The SDK consumes its output. |
| ext_authz at the agent ingress | Still worth building. The SDK does not block it and shares its endpoint. |
| Reimplementing grant resolution client-side | Server-side only, by design. |
| Slack identity | `identity_type=slack` needs a team scope and resolves to the owning account. The custom adapter is web-shaped. |

## Cross-repo follow-up

Shipping this makes two current statements wrong, and CLAUDE.md's workflow step 4
requires resolving that rather than leaving it silent. Both are one-line edits in
`astropods/astro`:

- `DeploymentCustomAuth.Grants` comment in
  `apps/astro-server/internal/deployment/deployment_spec.go`: "not enforced by
  the platform" becomes "not enforced at the ingress; enforced in-process by
  agents using the auth SDK".
- `docs/00-RFC/RFC-2-deployment-spec.md` §13 rule 25: same correction. The rule
  itself still holds.

`docs/changelog/feat/custom-interface-grant-access-2026-06-26.md` is a changelog
and stays as written. It records what was true at the time.
