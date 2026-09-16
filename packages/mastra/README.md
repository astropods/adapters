# @astropods/adapter-mastra

## Sandboxes

`sandboxTools()` gives an agent a sandbox: an isolated machine it can run
commands in, hold files in, and keep a background process alive in.

```ts
import { sandboxTools } from "@astropods/adapter-mastra";

const agent = new Agent({
  name: "coder",
  model: astroGateway("claude-sonnet-4-6"),
  memory,
  tools: { ...sandboxTools() },
});
```

The thread id names the sandbox. There is no mapping table: one thread is one
sandbox, so a conversation that resumes next week reattaches to its own files,
and two threads never share a filesystem. Mastra supplies `threadId` only when
the agent has memory configured; without one the tools fail rather than
quietly putting every thread in one sandbox. Pass `sandbox: "name"` to pin one
on purpose.

| Tool | For |
|---|---|
| `sandbox_exec` | A short command. Output is capped |
| `sandbox_run` | An install or a build. No cap, waits for the exit |
| `sandbox_read_file`, `sandbox_write_file` | Files, without shelling out |
| `sandbox_list_dir`, `sandbox_grep` | Looking around |
| `sandbox_spawn`, `sandbox_poll`, `sandbox_kill` | A server or watcher that keeps running |

`sandbox_poll` returns `stdout_next`; pass it back as `stdout_from` to read
only what is new. An agent that polls while a process runs loses nothing, and
`dropped_bytes` tells it when output outran the buffer instead of leaving a
silent gap.
