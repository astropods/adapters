# Astropods Adapters

Astro is a platform-agnostic deployment platform for AI agents — it doesn't care which framework or model you use. Adapters are the bridge between your agent and the Astro runtime: they implement a thin interface that lets Astro handle messaging, streaming, voice, and observability without requiring any changes to your agent code. You keep your framework; Astro handles the infrastructure.

- **CLI [docs](https://docs.astropods.com)**
- **Read our [blog](https://blog.astropods.com)**
- **Join the [waitlist](https://blog.astropods.com/waitlist)**

## Packages

| Package | Description |
|---------|-------------|
| [`@astropods/adapter-core`](./packages/core) | Framework-agnostic `AgentAdapter` interface and `MessagingBridge` that connects any adapter to the Astro messaging gRPC service. |
| [`@astropods/adapter-mastra`](./packages/mastra) | Mastra-specific adapter. Wraps a Mastra `Agent` and translates its `fullStream` chunks into the `StreamHooks` lifecycle, including voice (STT + TTS) support. |
| [`@astropods/adapter-ai-sdk`](./packages/ai-sdk) | Vercel AI SDK adapter. Serves an `Experimental_Agent` over messaging and exposes `astroTelemetry()` to wire `experimental_telemetry` to Astro's OTLP exporter. |
| [`@astropods/adapter-langchain`](./packages/langchain-js) | LangChain.js adapter. Serves a `createAgent`/`createReactAgent` agent over messaging and exposes `instrumentLangChain()` for OpenTelemetry tracing. |
| [`@astropods/adapter-claude-agent-sdk`](./packages/claude-agent-sdk) | Drop-in replacement for `@anthropic-ai/claude-agent-sdk` that adds OpenTelemetry instrumentation. |
| [`astropods-adapter-core`](./packages/core-py) | Python port of `adapter-core`: the same `AgentAdapter` interface and messaging bridge, plus an `astropods_adapter_core.auth` module for agents serving their own HTTP surface. |
| [`astropods-adapter-langchain`](./packages/langchain) | Python LangChain adapter. Wraps a `create_agent` executor and serves it over messaging, with `OpenAIVoice` and `setup_observability()` alongside. |

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

Implement `AgentAdapter` from `@astropods/adapter-core` (TS) or `astropods-adapter-core` (Python) to connect any agent framework:

```typescript
import { serve } from '@astropods/adapter-core';
import type { AgentAdapter } from '@astropods/adapter-core';

const adapter: AgentAdapter = {
  name: 'My Agent',
  async stream(prompt, hooks, options) {
    // options.platformContext exposes channel, thread, workspace, eventKind, etc.
    // when the message originated from a platform adapter (Slack, Discord, web).
    hooks.onChunk('Hello!');
    hooks.onFinish();
  },
  getConfig() { return { systemPrompt: '', tools: [] }; },
};

serve(adapter);
```

See [`packages/core`](./packages/core/README.md) (TypeScript) or [`packages/core-py`](./packages/core-py/README.md) (Python) for the full interface, including how to use `PlatformContext` to branch on the source event (DM vs @-mention vs thread reply) and reply back into the right channel and thread.

## Releasing

Versions come from [conventional commits](https://www.conventionalcommits.org).
Never hand-edit a version in `package.json` or `pyproject.toml`. Commitlint
checks the format on every pull request.

| Commit prefix | Bump |
|---------------|------|
| `fix:` | patch |
| `feat:` | minor |
| any type with `!` or a `BREAKING CHANGE:` footer | major |
| `chore:`, `docs:`, `test:`, `refactor:` | none |

Two tools split the work by ecosystem. They never touch the same package,
because lerna only sees a directory with a `package.json`.

### Python packages

`packages/core-py` and `packages/langchain` publish to PyPI via
[release-please](https://github.com/googleapis/release-please).

1. Merge your `feat:` or `fix:` commit to `main`.
2. Release-please opens a pull request per package, titled
   `chore(release): publish <package> <version>`. Check the version and
   changelog it proposes.
3. Merge it. That rewrites `pyproject.toml`, writes `CHANGELOG.md`, and tags
   the commit.
4. `publish-pypi-core.yml` or `publish-pypi.yml` uploads to PyPI on its own,
   because the release commit touches `pyproject.toml`.

Nothing to run by hand. If no release pull request appears, your commits were
types that do not bump, or they did not touch a package path.

### npm packages

The other packages publish to npm via lerna, on two channels.

- **Preview.** Every push to `main` publishes a canary under the `next` tag.
  Install it with `bun add @astropods/adapter-mastra@next`.
- **Stable.** Run the **Publish** workflow manually with `channel: latest`.
  Lerna versions the changed packages, tags them, publishes to `latest`, and
  pushes the `chore(release): publish` commit back to `main`.

### Checking a release

```bash
curl -s https://pypi.org/pypi/astropods-adapter-core/json | jq -r .info.version
npm view @astropods/adapter-core version
```

A PyPI upload is skipped when that version already exists, so a release that
appears to succeed while the version stays put means the bump never happened.

## Contributing

We welcome adapters for any agent framework. If you've built an agent with LangChain, CrewAI, or anything else, we'd love a contribution. Open a pull request or [file an issue](https://github.com/astropods/adapters/issues) to get started.
