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

There is no hand-written toolset any more. An earlier pass shipped nine tools
per framework, described once and mapped into each framework's tool type. Both
frameworks turned out to have a provider interface instead, and each builds its
own filesystem tools on top, so the toolset was two layers of duplication:
ours beside theirs. It is deleted rather than kept as a second way in.

```ts
// Mastra: a provider the workspace drives
new Workspace({ sandbox: new AstroSandbox({ name: threadId }) });
// LangChain, via Deep Agents: a backend the harness drives
createDeepAgent({ model, backend: new AstroSandbox({ name: threadId }) });
```

### The thread id is the sandbox name

Both take the name at construction, which is where a thread id belongs, and
neither keeps a mapping table. One thread is one sandbox, so a conversation
that resumes reattaches to its own files and two conversations never share a
filesystem. Naming it at construction also removes the failure the toolset
had to guard against, where a turn arrived with no thread and the only safe
answer was to refuse.

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

### The adapter passes the conversation through

A dynamic workspace or tool set resolves from a `requestContext`, and that
resolver's signature carries no thread: it receives `requestContext` and
`mastra`, nothing else. The messaging adapter already knew the conversation
but only put it in `memory.thread`, where a resolver cannot read it. It now
also sets `threadId` and `resourceId` on the request context, which is what
lets an agent name a sandbox after its conversation.

## What review caught

Nine findings, each a real defect. The ones worth recording:

**A timeout was being retried as if it were a stale credential.**
`SandboxUnavailableError` wrapped every rejected fetch, including the client's
own `AbortSignal.timeout`, and the retry treated that as a moved endpoint. The
client aborts at 30s while the data plane's default is 60s, so a command in
that window ran, was abandoned, and ran again. The retry is now limited to 401
and 403, which the data plane answers before executing anything, and `exec`
always sends a `timeout_ms` no later than its own deadline so the sandbox
stops a command rather than leaving it running past the abort.

**A truncated read looked like a whole file.** Each stream is capped at 1 MiB
and base64 expands by 4/3, so a file past about 768 KiB decoded to a prefix
and was returned as a complete `Uint8Array`, which Deep Agents then reported
with `error: null`. A truncated result is now refused and names the cap.

**A large write failed inside `execve`.** The base64 payload went in as one
argument, and Linux caps a single argument at 128 KiB, so a file past about
96 KB never reached the shell: the sandbox answered "could not start the
command" and the error surfaced as `invalid_path`. Writes are now split on a
multiple of 4, so each chunk is valid base64 on its own.

**`grep` dropped every match for a single file.** GNU grep prints no filename
for one file operand, so `1:hello` parsed to `path: "1"` and a NaN line, and
the filter discarded it. Verified in the image: without `-H` the prefix is
absent, and with it directory output and the exit-1 no-match case are
unchanged.

**The Mastra process handle bypassed the base class entirely.** The base
constructor replaces `wait` with a wrapper that registers the caller's
callbacks, kills on `abortSignal`, and calls the subclass implementation with
no arguments. Output reaches listeners and the retained buffers only through
`emitStdout`/`emitStderr`. The override took an options parameter that was
always empty and never emitted, so spawn-time callbacks were dropped,
`handle.stdout` stayed empty, `handle.reader` never yielded, and an aborted
wait rejected with a 404. It now calls `super(options)`, emits every polled
chunk, takes no parameters, and reads a post-kill 404 as the cancellation it
is.

**`executeCommand` could not be stopped.** Mastra's own tool always passes
`onStdout`, `timeout` and `abortSignal`, so the streaming branch always ran
and dropped the last two while `run` had no ceiling: the promise never
settled. Both are threaded through, and `run` kills the process when either
fires.

**Binary content was corrupted on the way in.** `writeFiles` sent a Buffer
through `toString("utf8")`, which replaces every invalid byte. It now uses the
byte-level write. The old test passed either way because its fixture was
ASCII; the new one uses a lone `0xff`.

**`start` claimed `connected` on evidence that could not support it.** It read
the row first, but a row outlives the VM it points at, so an existing row is
no proof of a live machine. Mastra branches on this to skip once-per-VM setup,
so it now always reports `created`: repeating setup is wasteful, skipping it on
a fresh machine is broken. Making this precise needs the control plane to say
whether an attach launched or resumed, which is a follow-up in astro-server.

**The LangChain package was invisible to CI.** `packages/langchain-js` is
`private: true`, which lerna honors, so `build`, `typecheck` and `test` each
reported four projects and never touched it: the Deep Agents backend and its
tests never ran. It was also the only package defining `typecheck`, so that
step passed by matching nothing. CI now runs the package directly, and the
other four define `typecheck` so the shared step checks something. Whether the
package should stay private is a publishing decision, left alone here.

## Migration

None. New API on `SandboxClient`, and a new export from each provider.
Existing behavior is unchanged; the one refactor, routing every data-plane
call through a single retry path, is covered by the existing tests.
