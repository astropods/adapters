from __future__ import annotations

import asyncio
import atexit
import json
import logging
import os
import sys
import threading
import time
from typing import Optional

from .bridge import MessagingBridge
from .types import AgentAdapter, ServeOptions

SHUTDOWN_THREAD_TIMEOUT_S = 5

logger = logging.getLogger(__name__)


class _JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        return json.dumps({"level": record.levelname.lower(), "msg": record.getMessage()})


def serve(adapter: AgentAdapter, options: Optional[ServeOptions] = None) -> None:
    """Connect an agent adapter to the Astro messaging service and start listening.

    Blocks until the process receives SIGINT or SIGTERM.
    """
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(_JsonFormatter())
    logging.basicConfig(level=logging.INFO, handlers=[handler], force=True)
    bridge = MessagingBridge(adapter, options)
    loop = asyncio.new_event_loop()
    code = 0
    try:
        loop.run_until_complete(bridge.start())
    except Exception as e:
        print(f"Fatal error: {e}", file=sys.stderr)
        code = 1
    finally:
        _close_loop(loop)
    _exit(code)


def _close_loop(loop: asyncio.AbstractEventLoop) -> None:
    tasks = asyncio.all_tasks(loop)
    for task in tasks:
        task.cancel()
    if tasks:
        loop.run_until_complete(asyncio.wait(tasks, timeout=SHUTDOWN_THREAD_TIMEOUT_S))
    loop.run_until_complete(loop.shutdown_asyncgens())
    loop.close()


def _worker_threads() -> list[threading.Thread]:
    return [
        t
        for t in threading.enumerate()
        if t is not threading.main_thread() and not t.daemon and t.is_alive()
    ]


def _exit(code: int) -> None:
    """Exit even when a cancelled turn left a blocking call running in a thread,
    which would otherwise keep the interpreter alive until it returns."""
    deadline = time.monotonic() + SHUTDOWN_THREAD_TIMEOUT_S
    for thread in _worker_threads():
        thread.join(max(0.0, deadline - time.monotonic()))
    stuck = _worker_threads()
    if stuck:
        logger.warning("Exiting with %d threads still running", len(stuck))
        atexit._run_exitfuncs()
        logging.shutdown()
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(code)
    if code:
        sys.exit(code)
