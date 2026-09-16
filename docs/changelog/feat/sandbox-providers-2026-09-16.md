# Sandbox support for LangChain and Mastra

## Summary

`SandboxClient` could attach a sandbox and run a command, which an agent
author had to wire into their framework themselves. Neither framework could
reach a sandbox without that glue, and the two would have written it
differently.

This adds the process and file methods the client was missing, then integrates
each framework the way that framework asks for.

## The two frameworks want different things

They are not symmetrical, and treating them as such was the first mistake
here.

**Mastra has a sandbox provider interface**, `MastraSandbox`, documented as
the extension point for exactly this and built for remote sandboxes: it has
protected `find`/`connect`/`create` hooks and a start outcome of `created` or
`connected`, which is our launch-versus-resume as a first-class concept. So
`AstroSandbox extends MastraSandbox`, and Mastra's own workspace drives it.
Its filesystem, mounts and built-in workspace tools all run against the
MicroVM rather than beside a toolset we maintain.

`SandboxProcessManager` turned out to be nearly one-to-one with the sandbox's
own process API, so `spawn`/`list`/`get`/`kill` map straight through, and
`ProcessHandle.wait()` polls to exit while handing each chunk to the caller's
callbacks.

**LangChain has one too, in `deepagents`.** Not in `@langchain/core` or
`langchain`, which is why a first look missed it. `BaseSandbox` asks for four
members and composes the rest itself:

```ts
abstract readonly id: string;
abstract execute(command: string): MaybePromise<ExecuteResponse>;
abstract uploadFiles(files: Array<[string, Uint8Array]>): MaybePromise<FileUploadResponse[]>;
abstract downloadFiles(paths: string[]): MaybePromise<FileDownloadResponse[]>;
```

`read`, `write`, `edit`, `delete`, `ls`, `glob` and `grep` are all built on
`execute` with POSIX utilities by the base class, so `AstroSandbox` is four
methods and the filesystem tools an agent sees are Deep Agents' own. That also
makes Astro swappable with the other backends, alongside `LocalShellBackend`
and `LangSmithSandbox`.

`execute` returns a single combined stream, so the client folds stderr into
stdout at the shell with `exec 2>&1` rather than concatenating the two after
the fact, which would lose the interleaving. Upload and download are binary,
which is why the client grew byte-level file methods and the text ones now sit
on top.

`sandboxTools()` stays for a LangChain agent not using Deep Agents, now also
packaged as `AstroSandboxToolkit` through `BaseToolkit`, LangChain's own way
of grouping a related set.

```ts
// Mastra: a provider the workspace drives
new Workspace({ sandbox: new AstroSandbox({ name: threadId }) });
// LangChain: tools the model calls
createAgent({ llm, tools: [...sandboxTools()] });
```

### The thread id is the sandbox name

There is no mapping table on either side. LangChain reads
`configurable.thread_id`, which LangGraph already threads through a run;
Mastra takes the name at construction, where the thread id belongs. One thread
is one sandbox, so a conversation that resumes reattaches to its own files and
two conversations never share a filesystem.

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
client through both, so the wire format can change without touching either,
and a test asserts the provider source contains neither header name.

### What the Mastra provider will not pretend

`supportsCheckpoints` is `false`. `snapshot()` suspends, which does snapshot
the MicroVM's memory, but only the latest state is ever recoverable and
persistence past the 8 hour ceiling is not built. `sendStdin()` throws,
because the data plane has no stdin and silently dropping a write would be
worse.

## Migration

None. New API on `SandboxClient`, and a new export from each provider.
Existing behavior is unchanged; the one refactor, routing every data-plane
call through a single retry path, is covered by the existing tests.
