# Creating a New Adapter

This guide explains how to build an adapter that connects any agent framework to Astro's messaging infrastructure. The Mastra adapter (`@astropods/adapter-mastra`) is the reference implementation.

## The AgentAdapter interface

Every adapter implements `AgentAdapter` from `@astropods/adapter-core`:

```typescript
import type { AgentAdapter, StreamHooks, StreamOptions } from "@astropods/adapter-core";
import type { AgentConfig } from "@astropods/astro-messaging";

interface AgentAdapter {
  /** Display name for the agent, used in logs and registration. */
  name: string;

  /** Stream a response, calling hooks as the agent progresses. */
  stream(prompt: string, hooks: StreamHooks, options: StreamOptions): Promise<void>;

  /** Return agent metadata for playground display. */
  getConfig(): AgentConfig;
}
```

Three things to implement: a `name`, a `stream` method, and a `getConfig` method.

## StreamHooks

The `stream` method receives a `hooks` object. Call these as your agent produces output:

| Hook | When to call |
|---|---|
| `hooks.onChunk(text)` | Each token/text fragment as the LLM streams |
| `hooks.onStatusUpdate(status)` | Agent state changes (thinking, tool use, etc.) |
| `hooks.onFinish()` | Response is complete |
| `hooks.onError(error)` | Something went wrong |

Status updates accept a `StatusUpdate` object:

```typescript
{ status: "THINKING" | "SEARCHING" | "GENERATING" | "PROCESSING" | "ANALYZING" | "CUSTOM",
  customMessage?: string,
  emoji?: string }
```

## StreamOptions

The `options` argument contains per-request context from the messaging platform:

| Field | Description |
|---|---|
| `conversationId` | Stable ID for the conversation thread |
| `userId` | ID of the user who sent the message |

Use these for memory/context management if your framework supports it.

## Step-by-step: building a LangChain adapter

Here's a walkthrough using LangChain as an example. Each new adapter lives in its own package under `packages/` in the adapters monorepo.

### 1. Create the adapter package

```
packages/
  langchain/
    package.json      (name: @astropods/adapter-langchain)
    tsconfig.json
    moon.yml
    src/
      index.ts
      adapter.ts
```

### 2. Implement AgentAdapter

```typescript
// packages/langchain/src/adapter.ts
import type { AgentAdapter, StreamHooks, StreamOptions } from "@astropods/adapter-core";
import type { AgentConfig } from "@astropods/astro-messaging";

// Import your framework
import type { AgentExecutor } from "langchain/agents";

export class LangChainAdapter implements AgentAdapter {
  readonly name: string;

  constructor(
    private executor: AgentExecutor,
    config: { name: string }
  ) {
    this.name = config.name;
  }

  async stream(
    prompt: string,
    hooks: StreamHooks,
    options: StreamOptions
  ): Promise<void> {
    try {
      // Call your framework's streaming API
      const stream = await this.executor.stream({ input: prompt });

      for await (const event of stream) {
        // Map framework events to hooks — this is adapter-specific.
        // Every framework emits different event shapes.
        if (event.output) {
          hooks.onChunk(event.output);
        }
      }

      hooks.onFinish();
    } catch (err) {
      hooks.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  getConfig(): AgentConfig {
    return {
      systemPrompt: "",  // Extract from your framework if available
      tools: [],         // Map your framework's tools to AgentToolConfig[]
    };
  }
}
```

### 3. Create the convenience serve function

```typescript
// packages/langchain/src/index.ts
import type { AgentExecutor } from "langchain/agents";
import { serve as serveAdapter } from "@astropods/adapter-core";
import type { ServeOptions } from "@astropods/adapter-core";
import { LangChainAdapter } from "./adapter";

export { LangChainAdapter } from "./adapter";

export function serve(
  executor: AgentExecutor,
  config: { name: string },
  options?: ServeOptions
): void {
  const adapter = new LangChainAdapter(executor, config);
  serveAdapter(adapter, options);
}
```

### 4. Set up package.json

```json
{
  "name": "@astropods/adapter-langchain",
  "dependencies": {
    "@astropods/adapter-core": "workspace:*"
  },
  "peerDependencies": {
    "langchain": ">=0.1.0"
  },
  "peerDependenciesMeta": {
    "langchain": { "optional": true }
  }
}
```

### 5. End result

```typescript
import { AgentExecutor } from "langchain/agents";
import { serve } from "@astropods/adapter-langchain";

const executor = AgentExecutor.fromAgentAndTools({ ... });

serve(executor, { name: "My LangChain Agent" });
```

## Key considerations

**Map status updates.** The messaging protocol supports status indicators (THINKING, PROCESSING, etc.) that show up in the playground and Slack. Map your framework's lifecycle events to these where possible. Without status updates the agent still works, but the UX is less informative.

**Handle errors in stream.** If your framework throws during streaming, catch it and call `hooks.onError()`. The bridge will send an error response to the messaging service. If an error escapes the `stream` method as an unhandled rejection, the bridge catches it as a fallback, but explicit handling is better.

**Call onFinish exactly once.** The bridge sends an `END` content chunk when `onFinish` fires. Missing it means the message never completes in the UI. Calling it twice sends duplicate end signals.

**getConfig is called once at startup.** It registers the agent's system prompt and tool list with the playground. It does not need to be dynamic. If your framework only exposes config asynchronously, return what you can synchronously and leave fields empty.

**Framework as peer dependency.** Declare your framework package as an optional peer dependency so it doesn't get pulled in for users of other adapters.
