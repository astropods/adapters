import os
from unittest.mock import MagicMock, patch, call

import pytest

from astropods_adapter_langchain.observability import setup_observability


class TestSetupObservabilityNoEndpoint:
    def test_no_op_when_env_not_set(self):
        env = os.environ.copy()
        env.pop("OTEL_EXPORTER_OTLP_ENDPOINT", None)

        with patch.dict(os.environ, env, clear=True):
            with patch("astropods_adapter_langchain.observability.TracerProvider") as mock_provider:
                setup_observability()
                mock_provider.assert_not_called()

    def test_no_op_does_not_instrument_langchain(self):
        env = os.environ.copy()
        env.pop("OTEL_EXPORTER_OTLP_ENDPOINT", None)

        with patch.dict(os.environ, env, clear=True):
            with patch("astropods_adapter_langchain.observability.LangchainInstrumentor") as mock_instrumentor:
                setup_observability()
                mock_instrumentor.assert_not_called()


class TestSetupObservabilityWithEndpoint:
    def test_configures_tracer_provider(self):
        with patch.dict(os.environ, {"OTEL_EXPORTER_OTLP_ENDPOINT": "http://localhost:4318"}):
            with patch("astropods_adapter_langchain.observability.TracerProvider") as mock_provider_cls, \
                 patch("astropods_adapter_langchain.observability.OTLPSpanExporter"), \
                 patch("astropods_adapter_langchain.observability.BatchSpanProcessor"), \
                 patch("astropods_adapter_langchain.observability.trace") as mock_trace, \
                 patch("astropods_adapter_langchain.observability.LangchainInstrumentor"):
                setup_observability()
                mock_provider_cls.assert_called_once()
                mock_trace.set_tracer_provider.assert_called_once()

    def test_instruments_langchain(self):
        with patch.dict(os.environ, {"OTEL_EXPORTER_OTLP_ENDPOINT": "http://localhost:4318"}):
            with patch("astropods_adapter_langchain.observability.TracerProvider"), \
                 patch("astropods_adapter_langchain.observability.OTLPSpanExporter"), \
                 patch("astropods_adapter_langchain.observability.BatchSpanProcessor"), \
                 patch("astropods_adapter_langchain.observability.trace"), \
                 patch("astropods_adapter_langchain.observability.LangchainInstrumentor") as mock_instrumentor_cls:
                mock_instrumentor = MagicMock()
                mock_instrumentor_cls.return_value = mock_instrumentor
                setup_observability()
                mock_instrumentor.instrument.assert_called_once()

    def test_appends_v1_traces_to_endpoint(self):
        with patch.dict(os.environ, {"OTEL_EXPORTER_OTLP_ENDPOINT": "http://localhost:4318"}):
            with patch("astropods_adapter_langchain.observability.TracerProvider"), \
                 patch("astropods_adapter_langchain.observability.OTLPSpanExporter") as mock_exporter_cls, \
                 patch("astropods_adapter_langchain.observability.BatchSpanProcessor"), \
                 patch("astropods_adapter_langchain.observability.trace"), \
                 patch("astropods_adapter_langchain.observability.LangchainInstrumentor"):
                setup_observability()
                mock_exporter_cls.assert_called_once_with(endpoint="http://localhost:4318/v1/traces")

    def test_strips_trailing_slashes_before_appending_path(self):
        with patch.dict(os.environ, {"OTEL_EXPORTER_OTLP_ENDPOINT": "http://localhost:4318///"}):
            with patch("astropods_adapter_langchain.observability.TracerProvider"), \
                 patch("astropods_adapter_langchain.observability.OTLPSpanExporter") as mock_exporter_cls, \
                 patch("astropods_adapter_langchain.observability.BatchSpanProcessor"), \
                 patch("astropods_adapter_langchain.observability.trace"), \
                 patch("astropods_adapter_langchain.observability.LangchainInstrumentor"):
                setup_observability()
                mock_exporter_cls.assert_called_once_with(endpoint="http://localhost:4318/v1/traces")

    def test_logs_when_tracing_enabled(self, capsys):
        with patch.dict(os.environ, {"OTEL_EXPORTER_OTLP_ENDPOINT": "http://localhost:4318"}):
            with patch("astropods_adapter_langchain.observability.TracerProvider"), \
                 patch("astropods_adapter_langchain.observability.OTLPSpanExporter"), \
                 patch("astropods_adapter_langchain.observability.BatchSpanProcessor"), \
                 patch("astropods_adapter_langchain.observability.trace"), \
                 patch("astropods_adapter_langchain.observability.LangchainInstrumentor"):
                setup_observability()
                captured = capsys.readouterr()
                assert "OTEL tracing enabled" in captured.out
                assert "/v1/traces" in captured.out
