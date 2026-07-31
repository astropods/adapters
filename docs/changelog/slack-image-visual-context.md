# Image attachments as visual context to the model

## Summary

Inbound IMAGE attachments were dropped before reaching the model:
`resolveAttachments` handled only FILE, and the Mastra adapter streamed a plain
text prompt. Agents therefore could not see images a user sent (e.g. a Slack
screenshot). Images now flow through to the model as visual content in the same
turn.

## Design

**Bridge.** A new `resolveImages` surfaces IMAGE attachments as
`StreamOptions.images: ImageInput[]`, each carrying its bytes inline as a data
URI in `url` (no files-volume round trip, no platform token needed agent-side).
Files still resolve to `StreamOptions.attachments` (a path on the shared volume)
exactly as before — images and files are separate channels, so existing
file-consuming agents are unaffected.

**Mastra adapter.** When `options.images` is non-empty, `stream()` hands
`agent.stream` a single user message whose content mixes the prompt text with
`{ type: "image", image: <dataURI> }` parts, so the model sees the image
alongside the text. With no images the plain-string prompt path is untouched.

## Migration

None for text-only agents. Other framework adapters (langchain, ai-sdk) are
unchanged; each can read `StreamOptions.images` to add its own multimodal
handling when desired.
