from __future__ import annotations

import logging
import os
from typing import Any, Optional

from langchain_core.messages import HumanMessage

from astropods_adapter_core.types import StreamHooks, StreamOptions

logger = logging.getLogger(__name__)


def _debug(*args: object) -> None:
    if os.environ.get("DEBUG"):
        logger.debug(*args)


def _text_from_content(content: Any) -> str:
    """Extract plain text from a LangChain message content field.

    Handles both string content (OpenAI-style) and list content blocks
    (Anthropic-style: [{"type": "text", "text": "..."}]).
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            block.get("text", "")
            for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        )
    return ""


class LangChainAdapter:
    """Adapts a LangGraph create_agent executor to the Astro messaging protocol.

    Uses astream(stream_mode="updates") to receive state updates from the graph.
    The "model" update contains the AI response; the "tools" update contains
    tool results. Note: responses arrive as complete messages (not token-by-token)
    because create_agent uses ainvoke internally with trace=False.
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
            async for chunk in self._executor.astream(
                {"messages": [HumanMessage(content=prompt)]},
                stream_mode="updates",
            ):
                if "model" in chunk:
                    for msg in chunk["model"].get("messages", []):
                        tool_calls = getattr(msg, "tool_calls", None) or []
                        if tool_calls:
                            for tc in tool_calls:
                                tool_name = tc.get("name", "tool") if isinstance(tc, dict) else getattr(tc, "name", "tool")
                                _debug("[LangChainAdapter] tool call: %s", tool_name)
                                hooks.on_status_update({
                                    "status": "PROCESSING",
                                    "custom_message": f"Running {tool_name}",
                                })
                        else:
                            text = _text_from_content(msg.content)
                            if text:
                                hooks.on_chunk(text)

                elif "tools" in chunk:
                    for msg in chunk["tools"].get("messages", []):
                        tool_name = getattr(msg, "name", "tool")
                        _debug("[LangChainAdapter] tool result: %s", tool_name)
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
