# Summary

A Mastra agent could not accept file uploads. `MastraAdapter.getConfig()`
returned only `systemPrompt` and `tools`, so `supports_files` defaulted to
false, the sidecar reported `capabilities.files: false`, and the chat client
hid its upload affordance. `serve()` took only `ServeOptions`, whose single
field is `serverAddress`, so there was no way to opt in short of writing a
custom adapter.

# Design

`serve(agent, { supportsFiles: true })` declares the capability, and
`MastraAdapter` accepts the same option directly for callers that construct it
themselves. `getConfig()` reports it on every call.

The default stays false. The capability describes what the agent does with a
file, which the adapter cannot infer from the Mastra agent: declaring it for
everyone would offer an upload button on agents that ignore attachments and
drop them silently.

`@astropods/messaging` moves to `^0.1.2`, the first release carrying
`supportsFiles` on `AgentConfig`.

# Migration

None for existing agents; they keep reporting no file support. An agent that
reads `StreamOptions.attachments` or `StreamOptions.images` should pass
`supportsFiles: true` to `serve()`.
