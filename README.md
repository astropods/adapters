# Astropods Adapters

Astro is a platform-agnostic deployment platform for AI agents — it doesn't care which framework or model you use. Adapters are the bridge between your agent and the Astro runtime: they implement a thin interface that lets Astro handle messaging, streaming, voice, and observability without requiring any changes to your agent code. You keep your framework; Astro handles the infrastructure.

- **CLI [docs](https://docs.astropods.ai)**
- **Read our [blog](https://blog.astropods.ai)**
- **Join the [waitlist](https://blog.astropods.ai/waitlist)**

## Packages

| Package | Description |
|---------|-------------|
| [`@astropods/adapter-core`](./packages/core) | Framework-agnostic `AgentAdapter` interface and `MessagingBridge` that connects any adapter to the Astro messaging gRPC service. |
| [`@astropods/adapter-mastra`](./packages/mastra) | Mastra-specific adapter. Wraps a Mastra `Agent` and translates its `fullStream` chunks into the `StreamHooks` lifecycle, including voice (STT + TTS) support. |

## Quick start

Install the adapter for your framework:

```bash
# Mastra
bun add @astropods/adapter-mastra
```

Connect your agent:

```typescript
import { Agent } from '@mastra/core/agent';
import { serve } from '@astropods/adapter-mastra';

const agent = new Agent({
  name: 'My Agent',
  instructions: 'You are a helpful assistant.',
  model: 'openai/gpt-4o',
});

serve(agent);
```

## Custom adapters

Implement `AgentAdapter` from `@astropods/adapter-core` to connect any agent framework:

```typescript
import { serve } from '@astropods/adapter-core';
import type { AgentAdapter } from '@astropods/adapter-core';

const adapter: AgentAdapter = {
  name: 'My Agent',
  async stream(prompt, hooks, options) { /* ... */ },
  getConfig() { return { systemPrompt: '', tools: [] }; },
};

serve(adapter);
```

See [`packages/core`](./packages/core) for the full interface.

## Contributing

We welcome adapters for any agent framework. If you've built an agent with LangChain, CrewAI, or anything else, we'd love a contribution. Open a pull request or [file an issue](https://github.com/astropods/adapters/issues) to get started.
