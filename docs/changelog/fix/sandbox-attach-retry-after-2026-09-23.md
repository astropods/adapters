# A first sandbox attach waits out its install

## Summary

astro-server now holds a sandbox until its declared environment is installed.
A first install takes minutes, which outlasts the proxy in front of the server,
so an attach that is still preparing answers `503` with `Retry-After`. Before
this change, `SandboxClient.attach` treated that as a failure.

## Design

`attach` retries a `503` only when the response carries a numeric
`Retry-After`, and sleeps for the time it names. A `503` without the header
comes from a server that runs no sandboxes, so it still fails at once.
Retries stop once the next wait would pass `prepareTimeoutSeconds` (default 15
minutes, the server's own preparation budget). The last `SandboxPreparingError`
then reaches the caller.

`exec` and every other call that attaches first get this without change.

## Migration

None. Pass `prepareTimeoutSeconds` to bound the wait more tightly.
