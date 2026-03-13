from __future__ import annotations

import logging
import os
from typing import Any, Optional

from astropods_adapter_core.types import StreamHooks, StreamOptions

logger = logging.getLogger(__name__)


def _debug(*args: object) -> None:
    if os.environ.get("DEBUG"):
        logger.debug(*args)


class LangChainAdapter:
    """Adapts a LangChain AgentExecutor to the Astro messaging protocol.

    Translates LangChain's astream_events into the StreamHooks lifecycle
    that the MessagingBridge expects.
    """

    def __init__(
        self,
        executor: Any,
        name: str = "LangChain Agent",
        system_prompt: str = "",
        tools: Optional[list] = None,
    ) -> None:
        self.name = name
        self._executor = executor
        self._system_prompt = system_prompt
        self._tools = tools or []

    async def stream(
        self, prompt: str, hooks: StreamHooks, options: StreamOptions
    ) -> None:
        try:
            async for event in self._executor.astream_events(
                {"input": prompt}, version="v2"
            ):
                kind = event["event"]

                if kind == "on_chat_model_stream":
                    chunk = event["data"].get("chunk")
                    if chunk and hasattr(chunk, "content") and chunk.content:
                        hooks.on_chunk(chunk.content)

                elif kind == "on_tool_start":
                    tool_name = event.get("name", "tool")
                    _debug("[LangChainAdapter] tool start: %s", tool_name)
                    hooks.on_status_update({
                        "status": "PROCESSING",
                        "custom_message": f"Running {tool_name}",
                    })

                elif kind == "on_tool_end":
                    tool_name = event.get("name", "tool")
                    _debug("[LangChainAdapter] tool end: %s", tool_name)
                    hooks.on_status_update({
                        "status": "ANALYZING",
                        "custom_message": f"Finished {tool_name}",
                    })

            hooks.on_finish()

        except Exception as e:
            hooks.on_error(e)

    def get_config(self) -> dict:
        tool_configs = [
            {
                "name": getattr(t, "name", str(t)),
                "title": getattr(t, "name", str(t)),
                "description": getattr(t, "description", ""),
                "type": "other",
            }
            for t in self._tools
        ]
        return {
            "system_prompt": self._system_prompt,
            "tools": tool_configs,
        }
