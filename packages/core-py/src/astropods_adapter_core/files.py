from __future__ import annotations

import os
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Callable, Iterator, Optional, Union

# Agent files mount, matching the K8s/compose deployer's AGENT_FILES_DIR.
DEFAULT_AGENT_FILES_DIR = "/data/files"

OnFile = Callable[[str, Optional[str], Optional[int]], None]

_turn_on_file: ContextVar[Optional[OnFile]] = ContextVar("astropods_turn_on_file", default=None)


def agent_files_dir() -> str:
    return os.environ.get("AGENT_FILES_DIR") or DEFAULT_AGENT_FILES_DIR


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
    the files dir.
    """
    on_file = _turn_on_file.get()
    if on_file is None:
        raise RuntimeError("attach_file must be called while the agent handles a message")
    if not name or name in (".", "..") or "/" in name or "\\" in name:
        raise ValueError(f"attach_file: invalid file name {name!r}")
    path = os.path.join(agent_files_dir(), name)
    if data is None:
        size = os.stat(path).st_size
    else:
        raw = data.encode() if isinstance(data, str) else data
        os.makedirs(agent_files_dir(), exist_ok=True)
        with open(path, "wb") as f:
            f.write(raw)
        size = len(raw)
    on_file(name, mime_type, size)
