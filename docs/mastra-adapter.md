# Mastra Adapter

Connect a [Mastra](https://mastra.ai) agent to Astro's messaging infrastructure with a single function call. The adapter handles gRPC connection, message routing, content streaming, and graceful shutdown automatically.

## Install

```bash
bun add @mastra/core @astromode-ai/astro-agent-adapters
```

## Quick start

```typescript
import { Agent } from "@mastra/core/agent";
import { serve } from "@astromode-ai/astro-agent-adapters/mastra";

const agent = new Agent({
  name: "My Agent",
  model: "openai/gpt-4o",
  instructions: "You are a helpful assistant.",
});

serve(agent);
```

That's it. The agent connects to the messaging service, registers itself, and starts handling messages.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `GRPC_SERVER_ADDR` | `localhost:9090` | Messaging service address. Injected automatically by `astro dev`. |
| `OPENAI_API_KEY` | | Required if using an OpenAI model. |
| `ANTHROPIC_API_KEY` | | Required if using an Anthropic model. |

## Adding tools

Mastra tools work out of the box. The adapter automatically surfaces them in the playground and sends status updates as tools execute.

```typescript
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { serve } from "@astromode-ai/astro-agent-adapters/mastra";

const weatherTool = createTool({
  id: "weather",
  description: "Get the current weather for a location",
  inputSchema: z.object({ location: z.string() }),
  outputSchema: z.object({ weather: z.string() }),
  execute: async ({ location }) => {
    const res = await fetch(`https://wttr.in/${location}?format=3`);
    return { weather: await res.text() };
  },
});

const agent = new Agent({
  name: "Weather Agent",
  model: "openai/gpt-4o",
  instructions: "Use the weather tool to answer questions about weather.",
  tools: { weatherTool },
});

serve(agent);
```

When the agent calls a tool, the playground will show status indicators like "Running weatherTool" and "Finished weatherTool" automatically.

## Memory

Mastra's memory integration is wired up automatically. Each conversation gets its own thread keyed by `conversationId`, and each user is tracked by their `userId` from the messaging platform. If your Mastra Agent has a `memory` configured, it will persist context across messages in the same conversation.

## Overriding the server address

The gRPC address is read from `GRPC_SERVER_ADDR` by default. You can override it:

```typescript
serve(agent, { serverAddress: "my-server:9090" });
```

## How it works

Under the hood, `serve(agent)` does the following:

1. Wraps the Mastra Agent in a `MastraAdapter`
2. Creates a `MessagingBridge` that connects to the gRPC messaging service
3. Sends the agent's config (name, instructions, tools) to the playground
4. Registers the agent on the messaging stream
5. For each incoming message:
   - Sends a `START` content chunk
   - Calls `agent.stream()` and iterates the full stream
   - Maps Mastra stream events to the messaging protocol:

     | Mastra event | Messaging action |
     |---|---|
     | `text-delta` | `DELTA` content chunk |
     | `reasoning-start` | `THINKING` status |
     | `reasoning-end` | `GENERATING` status |
     | `tool-call-input-streaming-start` | `PROCESSING` status |
     | `tool-call-input-streaming-end` | `ANALYZING` status |
     | `finish` | `END` content chunk |
     | `error` | Error response |

6. Handles SIGINT/SIGTERM for graceful shutdown

## Using MastraAdapter directly

If you need more control, use `MastraAdapter` with the generic `serve()`:

```typescript
import { Agent } from "@mastra/core/agent";
import { MastraAdapter } from "@astromode-ai/astro-agent-adapters/mastra";
import { serve } from "@astromode-ai/astro-agent-adapters";

const agent = new Agent({ name: "My Agent", model: "openai/gpt-4o", instructions: "..." });
const adapter = new MastraAdapter(agent);

serve(adapter);
```

This is equivalent to the Mastra-specific `serve(agent)` but gives you access to the adapter instance.
