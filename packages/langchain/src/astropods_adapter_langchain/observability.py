from __future__ import annotations

import os

from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.langchain import LangchainInstrumentor


def setup_observability() -> None:
    """If OTEL_EXPORTER_OTLP_ENDPOINT is set, configure the OTEL tracer provider
    and instrument LangChain automatically."""
    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
    if not endpoint:
        return

    traces_url = endpoint.rstrip("/") + "/v1/traces"

    provider = TracerProvider()
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=traces_url)))
    trace.set_tracer_provider(provider)
    LangchainInstrumentor().instrument()

    print(f"OTEL tracing enabled → {traces_url}")
