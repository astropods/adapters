from __future__ import annotations

import csv
import datetime
import math
import os
import threading
from collections import OrderedDict
from contextlib import closing, contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, Callable, Iterable, Iterator, Optional, Union

# Agent files mount, matching the K8s/compose deployer's AGENT_FILES_DIR.
DEFAULT_AGENT_FILES_DIR = "/data/files"
DEFAULT_MAX_FILE_MB = 100
# The messaging sidecar stores its blobs, metadata, and temp files under these suffixes.
_RESERVED_SUFFIXES = (".blob", ".meta.json", ".tmp")
_MAX_NAME_TRIES = 1000
_MAX_CONVERSATIONS = 1000
_MAX_FILES_PER_CONVERSATION = 100

# Characters ``read_file_page`` returns per page.
PAGE_CHARS = 20_000
# Rows ``read_table`` returns per page unless ``limit`` says otherwise.
PAGE_ROWS = 100
_MAX_PAGE_ROWS = 500

# Model-facing descriptions for a framework's file tools.
FILE_TOOL_DESCRIPTIONS = {
    "inspect_file": (
        "Describe an attached file: its kind, size, and text length, or for a table each sheet's "
        "columns and row count."
    ),
    "read_file": (
        f"Read one page ({PAGE_CHARS} characters) of an attached document's text: PDF, DOCX, or a "
        "text file. When next_offset is not null, the document has more text."
    ),
    "read_table": (
        f"Read one page of rows ({PAGE_ROWS} by default) from an attached CSV or XLSX file. When "
        "next_offset is not null, the table has more rows."
    ),
    "create_file": (
        "Create a text file, such as .md or .csv, and attach it to your reply. A taken name gets a "
        "number, so name the file as the result does, and read it later at the result's path."
    ),
}

_NO_TEXT_LAYER = (
    "This PDF has no text layer, so it is likely a scan. Reading it needs OCR, which this tool does not do."
)

OnFile = Callable[[str, Optional[str], Optional[int]], None]


@dataclass
class _Turn:
    on_file: OnFile
    # The only paths the read functions open: the conversation's attachments and the files it created.
    files: "OrderedDict[str, None]"


_turn: ContextVar[Optional[_Turn]] = ContextVar("astropods_turn", default=None)
# In memory, so a restarted agent forgets earlier turns' files. Least recently used first.
_conversations: "OrderedDict[str, OrderedDict[str, None]]" = OrderedDict()
# Sync tools run in worker threads.
_lock = threading.Lock()


def agent_files_dir() -> str:
    return os.environ.get("AGENT_FILES_DIR") or DEFAULT_AGENT_FILES_DIR


def _max_file_bytes() -> Optional[int]:
    """FILES_MAX_MB read as the messaging sidecar reads it; None is no limit."""
    raw = os.environ.get("FILES_MAX_MB", "").strip()
    mb = int(raw) if raw.isascii() and raw.isdigit() else DEFAULT_MAX_FILE_MB
    return None if mb == 0 else mb << 20


def _conversation_files(conversation_id: Optional[str]) -> "OrderedDict[str, None]":
    if not conversation_id:
        return OrderedDict()
    with _lock:
        files = _conversations.pop(conversation_id, None) or OrderedDict()
        _conversations[conversation_id] = files
        if len(_conversations) > _MAX_CONVERSATIONS:
            _conversations.popitem(last=False)
    return files


def _remember(files: "OrderedDict[str, None]", path: str) -> None:
    full = os.path.abspath(path)
    with _lock:
        files.pop(full, None)
        files[full] = None
        if len(files) > _MAX_FILES_PER_CONVERSATION:
            files.popitem(last=False)


@contextmanager
def run_in_turn(
    on_file: OnFile, conversation_id: Optional[str] = None, attachments: Iterable[str] = ()
) -> Iterator[None]:
    """Files stay readable in the conversation's later turns. Omit ``conversation_id`` to scope reads to this turn."""
    files = _conversation_files(conversation_id)
    for path in attachments:
        _remember(files, path)
    token = _turn.set(_Turn(on_file, files))
    try:
        yield
    finally:
        _turn.reset(token)


def _numbered_name(name: str, n: int) -> str:
    if n == 1:
        return name
    stem, ext = os.path.splitext(name)
    return f"{stem}-{n}{ext}"


def _write_new(name: str, raw: bytes) -> str:
    os.makedirs(agent_files_dir(), exist_ok=True)
    for n in range(1, _MAX_NAME_TRIES + 1):
        candidate = _numbered_name(name, n)
        try:
            # Every user's files share this dir, so overwriting would hand another user's file new bytes.
            with open(os.path.join(agent_files_dir(), candidate), "xb") as f:
                f.write(raw)
            return candidate
        except FileExistsError:
            continue
    raise FileExistsError(
        f"attach_file: {name} and {_MAX_NAME_TRIES - 1} numbered copies already exist in the files dir"
    )


def attach_file(
    name: str, data: Union[bytes, str, None] = None, mime_type: Optional[str] = None
) -> str:
    """Write a file to the agent's files dir and attach it to the current reply.

    Web chat shows it as a download chip and Slack uploads it into the thread.
    Call it from a tool while the agent handles a message; it raises outside
    one. ``name`` is one path segment. Omit ``data`` to attach a file already in
    the files dir. Returns the file's name, which gets a ``-2``, ``-3``, ...
    suffix when ``data`` is given for a name already in the files dir. It raises
    when the file is over ``FILES_MAX_MB``.
    """
    turn = _turn.get()
    if turn is None:
        raise RuntimeError("attach_file must be called while the agent handles a message")
    if not name or name in (".", "..") or "/" in name or "\\" in name:
        raise ValueError(f"attach_file: invalid file name {name!r}")
    if name.endswith(_RESERVED_SUFFIXES):
        raise ValueError(f"attach_file: a file name cannot end in {', '.join(_RESERVED_SUFFIXES)}")
    raw = data.encode() if isinstance(data, str) else data
    size = os.stat(os.path.join(agent_files_dir(), name)).st_size if raw is None else len(raw)
    limit = _max_file_bytes()
    if limit is not None and size > limit:
        raise ValueError(f"attach_file: {name} is larger than the {limit >> 20} MiB file size limit")
    written = name if raw is None else _write_new(name, raw)
    turn.on_file(written, mime_type, size)
    # A file attached without data can be another thread's, so the read functions must not open it.
    if raw is not None:
        _remember(turn.files, os.path.join(agent_files_dir(), written))
    return written


def create_file(name: str, content: str, mime_type: Optional[str] = None) -> dict:
    """``attached`` is the name the user sees, which differs from ``name`` when it is taken; ``path`` is what the read functions open."""
    attached = attach_file(name, content, mime_type)
    return {"attached": attached, "path": os.path.join(agent_files_dir(), attached)}


def attachment_note(attachments: Iterable[Any], images: Iterable[Any] = ()) -> str:
    """Names each attached file and its path for the model, leaving out files shown as ``images``."""
    shown = {image.key for image in images if getattr(image, "key", None)}
    files = [a for a in attachments if a.path and a.key not in shown]
    if not files:
        return ""
    listing = ", ".join(f"{f.name} ({f.path})" for f in files)
    return (
        "The user attached these files. Open them with a file-reading tool at the paths below. "
        f"Do not guess their contents. {listing}"
    )


def resolve_agent_file(path: str) -> str:
    """Rejects any file the current conversation did not receive or create."""
    turn = _turn.get()
    if turn is None:
        raise RuntimeError("Files can be read only while the agent handles a message")
    full = os.path.abspath(path)
    # Every thread's and user's files share one dir, so a path inside it can still be another owner's file.
    if full not in turn.files:
        raise PermissionError(
            "Only files attached to or created in this conversation can be read. "
            "Ask the user to attach the file again."
        )
    return full


def _sniff(path: str) -> str:
    """Staged uploads have no extension, so the kind comes from the bytes."""
    with open(path, "rb") as f:
        head = f.read(64 * 1024)
    if head[:4] == b"%PDF":
        return "pdf"
    if head[:2] == b"PK":
        if b"xl/" in head:
            return "xlsx"
        if b"word/" in head:
            return "docx"
        return "zip"
    return "binary" if b"\x00" in head else "text"


def _document_text(path: str, kind: str) -> str:
    if kind == "pdf":
        from pypdf import PdfReader

        return "\n".join(page.extract_text() or "" for page in PdfReader(path).pages)
    if kind == "docx":
        import mammoth

        with open(path, "rb") as f:
            return mammoth.extract_raw_text(f).value
    if kind == "text":
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    raise ValueError(f"A {kind} file has no text to read")


def _cell(value: Any) -> Any:
    return value.isoformat() if isinstance(value, (datetime.date, datetime.time)) else value


@contextmanager
def _xlsx_workbook(path: str) -> Iterator[Any]:
    from openpyxl import load_workbook

    # A file object, because openpyxl rejects a path that does not end in .xlsx, and staged uploads end in .blob.
    with open(path, "rb") as f:
        workbook = load_workbook(f, read_only=True, data_only=True)
        try:
            yield workbook
        finally:
            workbook.close()


def _sheet_rows(sheet: Any) -> Iterator[list[Any]]:
    """Streams rows, so a page of a large workbook never holds the whole sheet."""
    for row in sheet.iter_rows(values_only=True):
        if any(v is not None for v in row):
            yield [_cell(v) for v in row]


def _table_rows(path: str, kind: str, sheet: Optional[str] = None) -> Iterator[list[Any]]:
    """Yields the header row first."""
    if kind == "xlsx":
        with _xlsx_workbook(path) as workbook:
            names = workbook.sheetnames
            if sheet and sheet not in names:
                raise ValueError(f"No sheet named {sheet}. Sheets: {', '.join(names)}")
            yield from _sheet_rows(workbook[sheet or names[0]])
        return
    if kind != "text":
        raise ValueError(f"A {kind} file is not a table")
    # utf-8-sig drops the BOM that Excel's "CSV UTF-8" export writes, which would otherwise join the first column's name.
    with open(path, newline="", encoding="utf-8-sig", errors="replace") as f:
        for row in csv.reader(f):
            if row:
                yield row


def _delimited_table(path: str) -> Optional[dict]:
    columns: list[Any] = []
    rows = 0
    try:
        for row in _table_rows(path, "text"):
            if not columns:
                columns = row
            else:
                rows += 1
    except csv.Error:
        return None
    return {"columns": columns, "rows": rows} if len(columns) > 1 else None


def inspect_file(path: str) -> dict:
    """For a table, the row count is exact: every row is read."""
    full = resolve_agent_file(path)
    kind = _sniff(full)
    info: dict[str, Any] = {"kind": kind, "bytes": os.stat(full).st_size}
    if kind == "xlsx":
        info["tables"] = []
        with _xlsx_workbook(full) as workbook:
            for sheet in workbook.worksheets:
                rows = _sheet_rows(sheet)
                columns = next(rows, [])
                info["tables"].append({"name": sheet.title, "columns": columns, "rows": sum(1 for _ in rows)})
    elif kind in ("pdf", "docx", "text"):
        text = _document_text(full, kind)
        info["total_chars"] = len(text)
        info["pages"] = math.ceil(len(text) / PAGE_CHARS)
        if kind == "pdf" and not text.strip():
            info["scanned"] = True
        if kind == "text":
            table = _delimited_table(full)
            if table:
                info["tables"] = [table]
    return info


def read_file_page(path: str, offset: int = 0) -> dict:
    """Returns one page of a document's text, starting at ``offset``."""
    if offset < 0:
        raise ValueError("offset must be 0 or more")
    full = resolve_agent_file(path)
    kind = _sniff(full)
    text = _document_text(full, kind)
    if kind == "pdf" and not text.strip():
        raise ValueError(_NO_TEXT_LAYER)
    end = min(offset + PAGE_CHARS, len(text))
    return {
        "text": text[offset:end],
        "offset": offset,
        "next_offset": end if end < len(text) else None,
        "total_chars": len(text),
    }


def read_table(path: str, sheet: Optional[str] = None, offset: int = 0, limit: int = PAGE_ROWS) -> dict:
    """Returns ``limit`` data rows of a CSV or XLSX table, starting at data row ``offset``."""
    if offset < 0 or not 1 <= limit <= _MAX_PAGE_ROWS:
        raise ValueError(f"offset must be 0 or more, and limit from 1 to {_MAX_PAGE_ROWS}")
    full = resolve_agent_file(path)
    columns: Optional[list[Any]] = None
    index = 0
    rows: list[list[Any]] = []
    # closing() shuts the workbook when a page ends before the sheet does.
    with closing(_table_rows(full, _sniff(full), sheet)) as table:
        for row in table:
            if columns is None:
                columns = row
                continue
            if index >= offset + limit:
                return {"columns": columns, "rows": rows, "offset": offset, "next_offset": index}
            if index >= offset:
                rows.append(row)
            index += 1
    if columns is None:
        raise ValueError("The table is empty")
    return {"columns": columns, "rows": rows, "offset": offset, "next_offset": None}
