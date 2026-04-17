from __future__ import annotations

import asyncio
import json
import logging
import sys
from typing import Optional

from .bridge import MessagingBridge
from .types import AgentAdapter, ServeOptions


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
    try:
        asyncio.run(bridge.start())
    except Exception as e:
        print(f"Fatal error: {e}", file=sys.stderr)
        sys.exit(1)
