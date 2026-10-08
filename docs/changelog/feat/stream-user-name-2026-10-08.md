# Sender display name on StreamOptions

Closes astropods/astro#3126

## Summary

An agent could not greet or address the person it was answering by name. `StreamOptions` carried `userId`, which is the linked Astro user ID for a linked Slack user, and `platformContext`, which holds the raw Slack ID but no name. The bridge dropped `Message.user.username` on the way in.

## Design

The bridge now copies `Message.user.username` onto `StreamOptions`, as `userName` in TypeScript and `user_name` in Python. The messaging sidecar fills that field from Slack's `users.info` (astropods/messaging#99), so a Slack sender arrives with their display name, falling back to their real name and then their handle.

| | TypeScript | Python |
|---|---|---|
| Field | `userName?: string` | `user_name: str = ""` |
| No name sent | `undefined` | `""` |

The empty case follows each language's existing convention: `platformContext` is `undefined` in TypeScript, and the Python dataclass uses defaults. The Python field is last in the dataclass, so code that builds `StreamOptions` positionally keeps working.

Only the text-message path carries a name. Audio turns start from `AudioStreamConfig`, which has no user name.

## Migration

None. The field is optional. Agents see a name once their messaging sidecar runs a build with astropods/messaging#99; until then the field is empty.
