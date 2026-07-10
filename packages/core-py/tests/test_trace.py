from astropods_adapter_core.trace import create_traceparent


def test_create_traceparent_formats_w3c_header():
    assert (
        create_traceparent(
            trace_id="4BF92F3577B34DA6A3CE929D0E0E4736",
            span_id="00F067AA0BA902B7",
        )
        == "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
    )


def test_create_traceparent_uses_numeric_trace_flags():
    assert (
        create_traceparent(
            trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
            span_id="00f067aa0ba902b7",
            trace_flags=0,
        )
        == "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00"
    )


def test_create_traceparent_rejects_invalid_identifiers():
    assert (
        create_traceparent(
            trace_id="00000000000000000000000000000000",
            span_id="00f067aa0ba902b7",
        )
        == ""
    )
    assert (
        create_traceparent(
            trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
            span_id="0000000000000000",
        )
        == ""
    )
