# Sandbox tools for LangChain and Mastra

## Summary

`SandboxClient` could attach a sandbox and run a command, which an agent
author had to wire into their framework themselves. Neither framework could
reach a sandbox without that glue, and the two would have written it
differently.

This adds the process and file methods the client was missing, and a toolset
for each framework on top of them.

## Design

The sandbox operations live once, in `SANDBOX_TOOLS` in adapter-core: nine
tools with their names, their descriptions, and their argument shapes. Each
provider maps that list into its own tool type and supplies its own schema,
because each framework wants its own. A wording change to a tool description
happens in one place, and an agent behaves the same whichever framework it was
written in.

```ts
// LangChain
const agent = createAgent({ llm, tools: [...sandboxTools()] });
// Mastra
const agent = new Agent({ ..., tools: { ...sandboxTools() } });
```

### The thread id is the sandbox name

There is no mapping table on either side. LangChain reads
`configurable.thread_id`, which LangGraph already threads through a run;
Mastra reads the `threadId` it hands every tool execution. One thread is one
sandbox, so a conversation that resumes reattaches to its own files and two
conversations never share a filesystem.

A turn with no thread id is an error, not a fallback. Defaulting to a fixed
name would do the opposite of what the design is for: it would put every
conversation in one sandbox and let them read each other's files. Callers who
want one shared sandbox ask for it by name.

### Long output, and processes

`exec` buffers to exit and truncates, so the client now has the endpoints for
work that outlives a request: `spawn`, `poll`, `processes`, `signal`, `kill`.
`poll` reads from an offset and returns the next one, so an agent that keeps
polling loses nothing. `run` wraps the loop for the common case, resolving once
the command exits with the whole output assembled.

Loss is always visible. A poll reports `stdoutDropped` when output outran the
sandbox's retention window, rather than returning a gap that reads like
silence.

### Files are synthesized, not shelled out

`readFile`, `writeFile`, `listDir` and `grep` are built on exec, base64 on the
wire so newlines and binary survive. Paths are single-quoted for the shell,
with an embedded quote closed and reopened, and a test asserts the exact
quoted string because getting it wrong is a shell injection rather than a
formatting bug. `grep` treats no match as an empty result: exit 1 from grep is
an answer, not a failure.

No provider names a transport header. The header map stays opaque from the
client through both providers, so the wire format can change without touching
either.

## Migration

None. New API on `SandboxClient`, and a new export from each provider.
Existing behavior is unchanged; the one refactor, routing every data-plane
call through a single retry path, is covered by the existing tests.
