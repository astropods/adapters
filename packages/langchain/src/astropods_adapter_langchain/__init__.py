from __future__ import annotations

from typing import Optional

from .adapter import LangChainAdapter
from .voice import OpenAIVoice
from .observability import setup_observability
from astropods_adapter_core import serve as _core_serve, ServeOptions
from astropods_adapter_core.types import AgentAdapter


def serve(adapter: AgentAdapter, options: Optional[ServeOptions] = None) -> None:
    """Connect a LangChain agent to the Astro messaging service and start listening.

    When the ``OTEL_EXPORTER_OTLP_ENDPOINT`` environment variable is set,
    OTEL tracing is automatically configured via ``opentelemetry-instrumentation-langchain``.
    """
    setup_observability()
    _core_serve(adapter, options)


__all__ = ["LangChainAdapter", "OpenAIVoice", "serve", "ServeOptions"]
