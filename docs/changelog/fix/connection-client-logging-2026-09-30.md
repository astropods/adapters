# Log connection token requests

## Summary

`ConnectionClient` logged nothing. When an agent's GitHub call failed, its logs couldn't show whether Astropods refused the token (and why) or issued it and GitHub refused the request. The model then guessed at the cause, and it blamed a missing environment variable the agent no longer reads.

## Design

Every outcome of `getToken` now writes one structured line with `provider` and `user_id`. The TypeScript client uses the shared pino `logger`; Python uses the `astropods.connections` logger.

| Outcome | Level | Fields |
| --- | --- | --- |
| `connections: token issued` | info | `scopes`, `expires_at` |
| `connections: token reused from cache` | debug | `expires_at` |
| `connections: token refused` | warn | `status`, `code` (`not_consented`, `not_active`, …) |
| `connections: token request failed` | warn | the transport error |
| `connections: token refused, no user for this turn` | warn | none |

The access token is never logged. Both suites assert this.

## Migration

None.
