# @astropods/adapter-claude-agent-sdk

Drop-in replacement for `@anthropic-ai/claude-agent-sdk` that adds OpenTelemetry instrumentation for Astro deployments. Re-exports the entire SDK surface with `query()` instrumented, so `query()` calls, sub-agent steps, tool calls, and model invocations flow into the Astro dashboard automatically.

## Installation

```bash
bun add @astropods/adapter-claude-agent-sdk
```

Remove any direct dependency on `@anthropic-ai/claude-agent-sdk`. The adapter is versioned independently and tracks `@anthropic-ai/claude-agent-sdk ^0.3.142` — patches and minors within that range are supported.

## Usage

Point existing imports at the adapter:

```typescript
import { query, tool, AbortError, type SDKMessage } from "@astropods/adapter-claude-agent-sdk";
```

The full Claude Agent SDK surface is available unchanged; `query()` is patched to emit OpenTelemetry spans.

When deployed on Astro, `OTEL_EXPORTER_OTLP_ENDPOINT` is injected automatically and traces appear on the agent's detail page within ~30 seconds. The variable is unset during local development, so instrumentation is skipped there.

## API

This package re-exports `@anthropic-ai/claude-agent-sdk` in full. Only `query` is wrapped; every other binding (`tool`, `AbortError`, `SDKMessage`, etc.) is passed through verbatim, so new SDK exports flow through automatically.

### `query(options)`

Same signature as the upstream `query()`. Each call opens a parent span and emits child spans for sub-agent steps, tool calls, and model invocations. If `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, instrumentation is a no-op and behavior is identical to the upstream SDK.

## Troubleshooting

If traces don't show up in the dashboard:

- Confirm `OTEL_EXPORTER_OTLP_ENDPOINT` is present in the deployed container.
- Confirm every import of `@anthropic-ai/claude-agent-sdk` in your codebase has been switched to `@astropods/adapter-claude-agent-sdk`.
- Check the agent container logs for OpenTelemetry export errors.
