# A first sandbox attach waits out its install

## Summary

astro-server now holds a sandbox until its declared environment is installed.
A first install takes minutes, which outlasts the proxy in front of the server.
So an attach that is still preparing answers `202 Accepted` with `Retry-After`
and `state: "creating"`, and no endpoint. Before this change,
`SandboxClient.attach` read that 202 as a ready handle with an empty endpoint.

## Design

`attach` treats a 202 as "call again": it sleeps for the `Retry-After` it
names (5 seconds when absent) and repeats the `PUT`. Retries stop once the
next wait would pass `prepareTimeoutSeconds` (default 15 minutes, the server's
own preparation budget), and `attach` throws `SandboxPreparingError`.

Every other status keeps its meaning. A 503 still fails at once, because it
means the server runs no sandboxes.

`exec` and every other call that attaches first get this without change.

## Migration

None. Pass `prepareTimeoutSeconds` to bound the wait more tightly.
