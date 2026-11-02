# Python agents can read attached files

Part of astropods/astro#3546

## Summary

A Python agent could return a file with `attach_file`, but it had no way to read the files a user attached. The LangChain adapter told the model each file's path and asked it to use a file-reading tool, and gave it none. Each Python agent author wrote their own reader for PDF, DOCX, XLSX, and CSV.

## Design

core-py exports the same read functions as adapter-core, with Python names: `inspect_file`, `read_file_page`, `read_table`, `create_file`, `attachment_note`, and `resolve_agent_file`, with `PAGE_CHARS`, `PAGE_ROWS`, and `FILE_TOOL_DESCRIPTIONS`. They behave as the TypeScript functions do:

- The kind is read from the bytes, because a staged upload is `<key>.blob` with no extension.
- `read_file_page` returns one 20,000-character page, and `read_table` streams a CSV and stops after the page. The CSV reader drops the byte-order mark that Excel's "CSV UTF-8" export writes.
- A PDF with no text layer has `scanned: True` from `inspect_file`, and `read_file_page` raises to say it needs OCR.
- `pypdf`, `mammoth`, and `openpyxl` are dependencies of core-py, imported only when an agent reads a file of that kind. openpyxl gets an open file, because it rejects a path that does not end in `.xlsx`.

The read scope is the conversation, as in adapter-core. The turn context that holds `on_file` now holds a set of full paths for the conversation: the attachments of every message in it, and each file `attach_file` writes. The bridge keeps the set in memory for the 1,000 most recent conversations, up to 100 files each. A file attached without data stays out, because it can be another thread's. A path outside the set raises `PermissionError`, and a read outside a turn raises `RuntimeError`. Sync tools run in worker threads, so a lock guards the set.

The LangChain adapter's `file_tools()` returns the four tools as `StructuredTool`s with the shared descriptions. Each tool turns an error into a `ToolException` with `handle_tool_error=True`, so a refused path or a scanned PDF goes back to the model as the tool's result instead of ending the run. `file_tools()` imports the core functions when it is called, and raises an `ImportError` that names the version when core-py is older than 0.11.0. The adapter's dependency floor stays at 0.6.0 until core-py 0.11.0 is published.

## Testing

- core-py: the read functions run over the same PDF, DOCX, and XLSX fixtures as adapter-core and generated CSVs. The scope tests cover a later turn of the same conversation, another conversation, a file attached without data, and a read outside a turn. A bridge test sends a follow-up and a message in another conversation.
- LangChain: `create_agent` with `file_tools()` runs through the real bridge with a fake model. A later message in the same thread reads the earlier file, and a message in another thread gets the refusal as the tool result. Each scope test fails with its fix removed.

## Migration

None. To read attached files, add `*file_tools()` to a LangChain agent's tools and pass `supports_files=True` to the adapter.
