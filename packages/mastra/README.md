# @astropods/adapter-mastra

## The sender's name

Each turn's request context carries `userName`, the sender's display name on the source platform (their Slack display name, or their Astro name in web chat). It is absent when the platform sent none, so check for it. Tell the model how to use the name, or it may repeat it in every reply:

```ts
const agent = new Agent({
  id: "greeter",
  name: "Greeter",
  model,
  instructions: ({ requestContext }) => {
    const name = requestContext.get("userName");
    return name
      ? `The user's name is ${name}. Greet them by name in your first reply only; don't repeat it after that.`
      : "You are a helpful assistant.";
  },
});
```

The request context also carries `threadId` and `resourceId`.

## Sandboxes

`AstroSandbox` is a Mastra sandbox provider, so Mastra's own workspace drives
it: the filesystem, the mounts and the built-in workspace tools all run
against the MicroVM. There is no parallel toolset to learn.

```ts
import { AstroSandbox } from "@astropods/adapter-mastra";
import { Workspace } from "@mastra/core/workspace";

const workspace = new Workspace({
  sandbox: new AstroSandbox({ name: threadId }),
});
```

The name is the sandbox. Use the thread id: one thread is one sandbox, so a
conversation that resumes reattaches to its own files and two threads never
share a filesystem.

### What it maps onto

| Mastra | Astro |
|---|---|
| `start()` | One attach. Reports `created` on the first call, `connected` after |
| `executeCommand()` | A short command, or a background process when you pass `onStdout`/`onStderr`, because a plain exec cannot stream |
| `processes` | `spawn`, `list`, `get`, `kill` over real background processes |
| `handle.wait()` | Polls to exit, handing each chunk to your callbacks as it arrives |
| `stop()` / `destroy()` | Suspend, and delete |
| `getInfo()` | Includes `timeoutAt`, the sandbox's 8 hour ceiling |

Mastra starts the sandbox on demand: its process manager calls
`ensureRunning()` before a spawn, so nothing has to start it by hand.

### What it does not do

`supportsCheckpoints` is `false`. `snapshot()` suspends, which does snapshot
the MicroVM's memory so the next attach resumes from it, but there is only
ever the latest state to return to. Persistence past the ceiling is not
built yet.

A process has no stdin. `sendStdin()` throws rather than accepting the write
and dropping it; pass input through the command or a file.
