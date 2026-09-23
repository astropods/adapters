# Only "sandboxes cannot be used here" raises SandboxNotEnabledError

## Summary

`SandboxClient` turned every 409 into `SandboxNotEnabledError`. The control
plane no longer has a per-account enable flag, and a 409 now covers several
causes: a failed install, a failed preparation, an undeclared class, a
workspace from another runtime. An agent catching `SandboxNotEnabledError` to
turn sandbox features off would therefore do so when an install failed, and
the failure would read as a configuration problem.

## Design

astro-server now puts a `code` in every sandbox refusal. The client reads it
alongside the message:

- `SandboxRequestError` carries `code` when the server sent one.
- `SandboxNotEnabledError` is raised only for a 409 whose code is
  `SANDBOXES_NOT_CONFIGURED` or `SANDBOX_NOT_DECLARED`. Both mean sandboxes
  cannot be used for this agent, and retrying does not help.
- Every other 409, including one with no code from an older server, is a
  plain `SandboxRequestError` with `status` 409. The message still carries the
  server's reason, such as the install step that failed.

`SandboxNotEnabledError` still extends `SandboxRequestError`, so code that
catches the base class is unaffected.

## Migration

Code that caught `SandboxNotEnabledError` to handle a failed install should
catch `SandboxRequestError` and check `code === "SANDBOX_APPLY_FAILED"` or
`"SANDBOX_PREPARE_FAILED"`. The `SandboxNotEnabledError` constructor now takes
the code as a second argument.
