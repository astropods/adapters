# The AI SDK adapter shows inline images to the model

Part of astropods/astro#3546

## Summary

The AI SDK adapter dropped `StreamOptions.images`, so an AI SDK agent could not describe a screenshot or a chart a user attached. The Mastra adapter already passes them. Builds on astropods/adapters#120, which added `attachmentNote`.

## Design

When a turn carries images, the adapter sends one user message whose content is the text part and one `image` part per image, the same shape as the Mastra adapter. Each part sets `mediaType` from the image's MIME type or its data URI, because without one the model reads the bytes as `image/jpeg`. `attachmentNote` gets the images, so an image shown inline is not also named as a file to open. With `memory: false`, the turn goes as `messages` instead of `prompt`, since a prompt string cannot hold an image.

The in-process history keeps the text and a line naming the images, for example `(Attached images: chart.png)`, not the image parts. A Slack inline image can be up to 2 MiB, which as a data URI is larger than the 256 KiB `maxHistoryBytes` default, so storing it would evict every earlier turn. The model sees the image on its own turn, and a follow-up sees its earlier answer and the image's name.

## Migration

None. An AI SDK agent receives the images a message carries with no code change.
