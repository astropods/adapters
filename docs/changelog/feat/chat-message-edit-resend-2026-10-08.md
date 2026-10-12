# Reset agent memory when a chat message is edited

## Summary

The Astropods web chat now lets a user edit a message they sent and get a new reply from that point, keeping the old reply as another version. The chat store branches, but the agent keeps its own memory per conversation, and that memory still holds the replaced turns. The messaging sidecar therefore sends the turns before the edited message as `Message.history`, and offers editing only for agents that declare they act on it with `AgentConfig.supports_history`. The platform side is `docs/01-spec/chat-message-edit-spec.md` in `astropods/astro`.

This change makes the packaged adapters act on `history` and declare it, so their agents get message editing without code changes.

## Design

**Core passes `history` through.** Both bridges read `Message.history` and hand it to `stream()` as `StreamOptions.history`: `{ messages, isComplete }` in TypeScript and `HistoryInput(messages, is_complete)` in Python. It is set only when the turns before the message differ from what the agent last answered, which covers an edit, a switch to another version, and a turn the agent never answered. An empty `messages` is meaningful: the user edited the first message, so the agent must forget everything. An ordinary turn has no `history`, and memory stays as it is.

`getConfig()` now returns core's `AgentConfig`, the messaging `AgentConfig` plus `supportsHistory`. The bridge sends it unchanged.

**Each adapter resets its own memory before the turn runs.** The history is text only, so tool calls and their results from earlier turns are not restored. A user turn that carried only files arrives as a line naming them.

- **Mastra** deletes the memory thread and saves the history into a new thread with the same ID and title. Deleting the thread drops thread-scoped working memory, which describes the old version. Resource-scoped working memory, Mastra's default, stays. An agent without memory has nothing to reset.
- **LangChain (TypeScript and Python)** deletes the checkpointer thread (`deleteThread` / `adelete_thread`) and sends the history ahead of the prompt, so the graph starts over from it. An agent without a checkpointer stores nothing, so it only receives the history for that turn.
- **AI SDK** replaces the conversation's in-process history, one turn per user message, under the same size limits as any other turn. This builds on the history the adapter gained in #93.

**A stopped turn must not write the old branch back.** The sidecar accepts a send as soon as the user stops a turn, and an edit sent then can run while the stopped turn is still finishing. LangChain now passes the stop signal to the graph run, so the stopped run ends without writing its checkpoint. A Mastra run can outlive `stream()`: a tool that ignores the abort keeps running, and Mastra saves to memory when it returns. The Mastra adapter therefore tracks each conversation's latest run until `getFullOutput()` settles, and an edit waits for it, for at most 10 seconds, before it rebuilds the thread. If a reset fails after the old thread is deleted, the title is held in process, so a retry still restores it.

**The flag says whether the reset can happen.** Mastra reports `supportsHistory: true` by default. LangChain reports it when the checkpointer can delete a thread, or when there is none: in TypeScript the saver must have `deleteThread`, and in Python it must override `adelete_thread` or `delete_thread`, which `BaseCheckpointSaver` leaves raising `NotImplementedError`. A Python saver that cannot delete never fails a turn; the adapter logs it and handles the message as an ordinary turn. Both take `supportsHistory` (`supports_history` in Python), and an explicit value wins. The AI SDK adapter reports the flag whenever it keeps history, and not with `memory: false`, since that agent keeps its own. Claude Agent SDK and the AgentCore server are unchanged and never report it.

A sandbox keyed on the thread is not part of memory. After an edit it still holds files the replaced turns wrote; an agent for which that matters passes `supportsHistory: false`.

**It works against today's SDKs.** The published `@astropods/messaging` and `astropods-messaging` predate the new fields. The TypeScript bridge reads `history` through a local wire type, as it already does for attachment fields. The Python bridge checks the stubs' descriptor before it reads `history` or sets `supports_history`. Against an old SDK the field never arrives and the flag never leaves, so the chat keeps editing off. Python tests that need the new stubs skip until they are installed.

## Migration

None for agents: the edit control appears on its own once the sidecar, SDK, and adapter releases are out. An agent that keeps conversation state outside Mastra memory or a LangGraph checkpointer, or keys a sandbox on the thread, should pass `supportsHistory: false`.

The fields reach the wire only after `@astropods/messaging` and `astropods-messaging` `0.3.0` ship them. When they do, move the dependency floors to `0.3.0` and refresh `bun.lock`, as was done for `supports_files`.

`astropods-adapter-langchain` should then require `astropods-adapter-core>=0.10.0`, the release this change produces. Raise it after release-please publishes that version. CI installs core-py from the checkout, which stays at `0.9.1` until the release PR merges, so raising the floor earlier fails every Python job. Until then the adapter reads `history` with `getattr`, so an older core leaves edits off instead of failing.
