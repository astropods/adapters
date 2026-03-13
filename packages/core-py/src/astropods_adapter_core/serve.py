from __future__ import annotations

import asyncio
import sys
from typing import Optional

from .bridge import MessagingBridge
from .types import AgentAdapter, ServeOptions


def serve(adapter: AgentAdapter, options: Optional[ServeOptions] = None) -> None:
    """Connect an agent adapter to the Astro messaging service and start listening.

    Blocks until the process receives SIGINT or SIGTERM.
    """
    bridge = MessagingBridge(adapter, options)
    try:
        asyncio.run(bridge.start())
    except Exception as e:
        print(f"Fatal error: {e}", file=sys.stderr)
        sys.exit(1)
