# Audio/Voice Pipeline

End-to-end flow for processing voice input through the adapter layer.

## Overview

Audio sessions are driven entirely by the `audioConfig` event, which carries the
`conversationId`. The `[audio]` text message that precedes it is ignored (or
rejected if the adapter doesn't support audio). Once `audioConfig` arrives, the
bridge dispatches to the adapter's `streamAudio` method, which runs a
STT &rarr; LLM &rarr; TTS pipeline.

## Sequence

```
Client                    MessagingBridge                    MastraAdapter
(Twilio/WebSocket)       (packages/core)                   (packages/mastra)
  │                           │                                  │
  │  "[audio]" message        │                                  │
  │──────────────────────────>│  Ignored (or error if no audio   │
  │                           │  support on adapter)             │
  │                           │                                  │
  │  1. audioConfig event     │                                  │
  │  (encoding, sampleRate,   │                                  │
  │   channels, convId)       │                                  │
  │──────────────────────────>│                                  │
  │                           │  audioAsReadable() -> stream     │
  │                           │  Build AudioInput                │
  │                           │  Build StreamHooks               │
  │                           │  sendContentChunk(START)         │
  │                           │                                  │
  │  2. audioChunk events     │                                  │
  │  (raw audio bytes)        │  Piped into ReadableStream       │
  │──────────────────────────>│                                  │
  │                           │                                  │
  │                           │  streamAudio(audio, hooks, opts) │
  │                           │─────────────────────────────────>│
  │                           │                                  │
  │                           │                     ┌────────────┤
  │                           │                     │ STT        │
  │                           │                     │            │
  │                           │                     │ voice      │
  │                           │                     │ .listen()  │
  │                           │                     │    │       │
  │                           │                     │    v       │
  │                           │                     │ transcript │
  │                           │                     │ = "Hello"  │
  │                           │                     │            │
  │  <── onTranscript(text) ──│─────────────────────│            │
  │  (replaces "[audio]"      │                     └────────────┤
  │   placeholder)            │                                  │
  │                           │                     ┌────────────┤
  │                           │                     │ LLM        │
  │                           │                     │            │
  │                           │                     │ Has TTS?   │
  │                           │                     │ Y: wrap    │
  │                           │                     │    hooks   │
  │                           │                     │    (accum  │
  │                           │                     │    text,   │
  │                           │                     │    defer   │
  │                           │                     │    finish) │
  │                           │                     │ N: pass    │
  │                           │                     │    through │
  │                           │                     │            │
  │                           │                     │ stream()   │
  │                           │                     │   │        │
  │  <── DELTA "Hello" ───────│─────────────────────│   │        │
  │  <── DELTA " world" ──────│─────────────────────│   │        │
  │                           │                     │            │
  │                           │                     └────────────┤
  │                           │                                  │
  │                           │                   ┌── No TTS ───┤
  │                           │                   │              │
  │  <── END (onFinish) ──────│───────────────────│  Done.       │
  │                           │                   └──────────────┤
  │                           │                                  │
  │                           │                   ┌── Has TTS ──┤
  │                           │                   │              │
  │                           │                   │ voice.speak( │
  │                           │                   │  "Hello      │
  │                           │                   │   world")    │
  │                           │                   │  (accum.     │
  │                           │                   │   text)      │
  │                           │                   │   │          │
  │  <── audio bytes ─────────│───────────────────│   │          │
  │  <── audio end ───────────│───────────────────│   │          │
  │  <── END (onFinish) ──────│───────────────────│   │          │
  │                           │                   │              │
  │                           │                   └──────────────┤
  v                           v                                  v
```

## Key design decisions

### `[audio]` messages are ignored

The `[audio]` text message and the `audioConfig` event both carry the
`conversationId`. Since `audioConfig` is the authoritative start of an audio
session, the text message is redundant — the bridge ignores it. If the adapter
doesn't implement `streamAudio`, the bridge replies with a helpful error.

### Single LLM call

The adapter calls `stream()` once. When TTS is enabled, hooks are wrapped to:

1. **Accumulate text** &mdash; each `onChunk` appends to a buffer while still
   forwarding to the client.
2. **Defer `onFinish`** &mdash; the wrapped `onFinish` is a no-op; the real
   `onFinish` is called after TTS completes (or fails).

This ensures TTS receives the exact same text the client saw, with no second
LLM call.

### TTS is best-effort

If `voice.speak` throws, the error is logged as a warning but `onFinish` still
fires. The client already received the full text response, so the audio failure
is non-fatal.

### No TTS path

When the voice provider has no `speak` method, hooks pass through unmodified.
`onFinish` fires inside `stream()` as normal, and no audio chunks are sent.

## Debug logging

Diagnostic logs (`[bridge]`, `[audio]`, `[MastraAdapter]` prefixed) are gated
behind `process.env.DEBUG`. Set `DEBUG=1` to enable them. Startup messages,
errors, and warnings always print.
