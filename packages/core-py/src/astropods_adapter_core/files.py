from __future__ import annotations

import os
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Callable, Iterator, Optional, Union

# Agent files mount, matching the K8s/compose deployer's AGENT_FILES_DIR.
DEFAULT_AGENT_FILES_DIR = "/data/files"
DEFAULT_MAX_FILE_MB = 100
# The messaging sidecar stores its blobs, metadata, and temp files under these suffixes.
_RESERVED_SUFFIXES = (".blob", ".meta.json", ".tmp")

OnFile = Callable[[str, Optional[str], Optional[int]], None]

_turn_on_file: ContextVar[Optional[OnFile]] = ContextVar("astropods_turn_on_file", default=None)


def agent_files_dir() -> str:
    return os.environ.get("AGENT_FILES_DIR") or DEFAULT_AGENT_FILES_DIR


def _max_file_bytes() -> Optional[int]:
    """FILES_MAX_MB read as the messaging sidecar reads it; None is no limit."""
    raw = os.environ.get("FILES_MAX_MB", "").strip()
    mb = int(raw) if raw.isascii() and raw.isdigit() else DEFAULT_MAX_FILE_MB
    return None if mb == 0 else mb << 20


@contextmanager
def run_in_turn(on_file: OnFile) -> Iterator[None]:
    token = _turn_on_file.set(on_file)
    try:
        yield
    finally:
        _turn_on_file.reset(token)


def attach_file(
    name: str, data: Union[bytes, str, None] = None, mime_type: Optional[str] = None
) -> None:
    """Write a file to the agent's files dir and attach it to the current reply.

    Web chat shows it as a download chip and Slack uploads it into the thread.
    Call it from a tool while the agent handles a message; it raises outside
    one. ``name`` is one path segment. Omit ``data`` to attach a file already in
    the files dir. It raises when the file is over ``FILES_MAX_MB`` or when
    ``data`` is given for a name already in the files dir.
    """
    on_file = _turn_on_file.get()
    if on_file is None:
        raise RuntimeError("attach_file must be called while the agent handles a message")
    if not name or name in (".", "..") or "/" in name or "\\" in name:
        raise ValueError(f"attach_file: invalid file name {name!r}")
    if name.endswith(_RESERVED_SUFFIXES):
        raise ValueError(f"attach_file: a file name cannot end in {', '.join(_RESERVED_SUFFIXES)}")
    path = os.path.join(agent_files_dir(), name)
    raw = data.encode() if isinstance(data, str) else data
    size = os.stat(path).st_size if raw is None else len(raw)
    limit = _max_file_bytes()
    if limit is not None and size > limit:
        raise ValueError(f"attach_file: {name} is larger than the {limit >> 20} MiB file size limit")
    if raw is not None:
        os.makedirs(agent_files_dir(), exist_ok=True)
        try:
            # Every user's files share this dir, so overwriting would hand another user's file new bytes.
            with open(path, "xb") as f:
                f.write(raw)
        except FileExistsError:
            raise FileExistsError(
                f"attach_file: {name} already exists in the files dir; use a new name"
            ) from None
    on_file(name, mime_type, size)
