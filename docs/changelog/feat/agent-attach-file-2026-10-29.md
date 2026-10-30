# Agents can read and return files

Part of astropods/astro#3546

## Summary

A framework agent could neither read the files a user attached nor return one.

- Returning: `StreamHooks.onFile` (`on_file` in Python) delivers a file on the END chunk, and the messaging sidecar renders it as a web chat download chip or a Slack upload. Only `stream()` holds the hooks, and the Mastra, AI SDK, and LangChain adapters own `stream()` without calling the hook. A tool that produced an account plan had no way to hand it to the user.
- Reading: the Mastra adapter tells the model each attached file's path and asks it to use a file-reading tool, but it provides none. The AI SDK adapter does not mention attachments at all. Each agent author wrote their own reader, and one that pulled a file's text into the prompt made the model guess. A test agent asked for the row count of a 27 MB export read 20,000 characters and answered 500. The file has 344,975 rows.

## Design

### Returning a file

adapter-core exports `attachFile({ name, data?, mimeType? })`. It writes `data` to `AGENT_FILES_DIR/<name>` and calls the current turn's `onFile`. Without `data`, it attaches a file already in the files dir and reads its size from disk.

The bridge runs each turn's `stream()` and `streamAudio()` inside an `AsyncLocalStorage` that holds the turn's `onFile`. A tool reaches it however deep the framework runs it, with no change to any adapter and no new adapter option. Concurrent turns stay apart because each has its own async context. `AgentCoreServer` sets the same context. Its `onFile` is a no-op, so there the file is written but not delivered.

`attachFile` throws outside a turn rather than drop the file, and it rejects a name that is not one path segment.

Every user's files share one directory, and the model usually picks the name, so `attachFile` guards the files that are already there:

- With `data`, it creates the file exclusively and throws when the name exists. Otherwise one user's `summary.md` would replace the bytes behind another user's download chip.
- It rejects a name that ends in `.blob`, `.meta.json`, or `.tmp`. The messaging sidecar stores uploads, owner metadata, and temp files under those suffixes.
- It throws when the file is over `FILES_MAX_MB`, read as the sidecar reads it: 100 MiB when unset, no limit at `0`. The sidecar checks the limit only after the turn ends, so without this the model would say a file is attached when it never arrives.

A thrown error fails the tool call, so the model sees the reason and can pick a new name or tell the user.

The Mastra and AI SDK suites each gain a test in which a model calls a tool. The tool checks that it runs in the async context `stream()` was called in. Those tests fail if a framework release moves tool execution out of that context. The Claude Agent SDK package only instruments the SDK. Its agents write their own `stream()` and already hold the hooks.

core-py exports the same function as `attach_file(name, data=None, mime_type=None)`. It is synchronous, so sync and async tools both call it. The bridge sets a `ContextVar` around `stream()` and `stream_audio()`. asyncio tasks and LangChain's tool threads copy the context, so the value reaches the tool. A LangChain test runs `create_agent` with a sync tool and an async tool, and checks that both see the context set by the caller.

### Reading files

`@astropods/adapter-core/files` is a new subpath with framework-neutral functions. Each takes an attachment's `path` and rejects one outside `AGENT_FILES_DIR`.

| Function | Returns |
|---|---|
| `inspectFile` | Kind, size, text length, and for a table its columns, exact row count, and sample rows |
| `readFilePage` | One 20,000-character page of text, with `nextOffset` |
| `queryTable` | Matching rows, an exact match count, and an optional count, sum, min, max, or avg over a column |
| `attachmentNote` | The line that names each attached file and its path for the model |

The kind is sniffed from the bytes (`%PDF`, and the parts inside a zip for DOCX and XLSX), because a staged upload is `<key>.blob` with no extension. `queryTable` streams a CSV through `csv-parse`, so counts and totals cover the whole file while only the returned rows are capped. The parser strips the byte-order mark that Excel's "CSV UTF-8" export writes, which would otherwise join the first column's name. A column aggregate reads `$1,200` as 1200, leaves out empty and non-numeric cells, averages over the cells it counted, and returns the number it left out as `skipped`. A blank cell read as 0 would make `min` 0 and pull `avg` down. A PDF with no text layer, such as a scan, has `scanned: true` from `inspectFile`, and `readFilePage` throws to say it needs OCR, so the model does not answer from an empty read. `unpdf`, `mammoth`, `read-excel-file`, and `csv-parse` are dependencies of adapter-core, imported dynamically, so an agent that never reads a file does not load them. The functions live on a subpath so the main entry stays as it was.

`fileTools()` in the Mastra and AI SDK adapters wraps those functions as four tools: `inspect_file`, `read_file`, `query_table`, and `create_file` (which calls `attachFile`). The tool descriptions come from adapter-core's `FILE_TOOL_DESCRIPTIONS`, so both frameworks give the model the same instructions, including "never estimate from sample rows". An agent opts in with `tools: { ...fileTools() }`. Both adapters declare `zod` as a peer dependency, with the range their framework accepts.

The AI SDK adapter now appends the same attachment note as the Mastra adapter, and takes a `supportsFiles` option that it reports in its config, as Mastra does. The note text moves from the Mastra adapter into adapter-core, so the two cannot drift. The AI SDK adapter still does not pass images to the model. It keeps turns in an in-process history, and inlined image bytes there need their own design.

Python agents get `attach_file` but no `fileTools()` yet.

## Migration

None. To return a file, call `attachFile` (TypeScript) or `attach_file` (Python) from a tool. To read attached files, add `...fileTools()` to a Mastra or AI SDK agent's tools. An AI SDK agent that reads files sets `supportsFiles: true` to turn on web chat uploads.
