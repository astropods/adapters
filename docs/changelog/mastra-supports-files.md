# Summary

Neither a Mastra (TS) nor a LangChain (Python) agent could accept file uploads,
and neither could see an inline image.

A custom adapter has always been able to opt in, because it writes `getConfig()`
itself. The packaged adapters could not: `MastraAdapter.getConfig()` returned a
fixed `{ systemPrompt, tools }`, `LangChainAdapter.get_config()` returned a
fixed `{ system_prompt, tools }`, and neither `serve()` accepted a capability.
So the chat client hid its upload affordance for every agent built on them.

The Python path had a second gap. `core-py` carried `attachments` but no
`images`, dropped inbound IMAGE attachments entirely, and omitted
`supports_files` when building the `AgentConfig` it sends at startup. A Python
agent therefore could not receive an image even if it declared the capability.

# Design

Both adapters take the capability as a constructor or `serve()` option and
report it from their config:

```ts
serve(agent, { supportsFiles: true });
```

```python
LangChainAdapter(executor, supports_files=True)
```

The default stays false in both. The capability describes what the agent does
with a file, which an adapter cannot infer from a Mastra agent or a LangGraph
executor; declaring it for everyone would show an upload button on agents that
ignore attachments and drop them silently.

`core-py` gains `ImageInput` and `StreamOptions.images`, resolved from IMAGE
attachments the same way the TS bridge does: bytes arrive inline as a `data:`
URI, so there is no volume round trip and an attachment without a url is
skipped. Its bridge now forwards `supports_files` onto the wire.

`LangChainAdapter` sends a multimodal user message when the turn carried
images, mixing `image_url` blocks with the prompt text. A text-only turn keeps
its plain-string content so existing behaviour is untouched.

A packaged adapter owns `stream()`, so an agent author never sees
`StreamOptions` and cannot reach a non-image attachment. Both adapters therefore
append a line to the turn's text naming each such file and its path, which a
tool can read. A file with no resolvable path is skipped: naming a path the
agent cannot open would only invite a failed tool call.

Suppressing the copy of an image already delivered inline matches on the
files-API key, not the filename, so `ImageInput` now carries `key` alongside the
attachment it came from. Two uploads can share a display name while only one
fits the inline budget, and matching on the name would have hidden the one the
model cannot see.

Dependency floors move to the first releases carrying `supports_files` on
`AgentConfig`: `@astropods/messaging` `^0.1.2` for Mastra, and
`astropods-messaging>=0.1.2` for `core-py`.

# Migration

None for existing agents; they keep reporting no file support. An agent that
reads attachments or images should pass the capability to `serve()` (TS) or the
adapter constructor (Python).
