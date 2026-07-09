from __future__ import annotations

import re
from typing import Union

_TRACE_ID_PATTERN = re.compile(r"^[0-9a-f]{32}$")
_SPAN_ID_PATTERN = re.compile(r"^[0-9a-f]{16}$")
_TRACE_FLAGS_PATTERN = re.compile(r"^[0-9a-f]{2}$")


def create_traceparent(
    *,
    trace_id: str | None,
    span_id: str | None,
    trace_flags: Union[int, str] = "01",
) -> str:
    normalized_trace_id = _normalize_trace_id(trace_id)
    normalized_span_id = _normalize_span_id(span_id)
    normalized_trace_flags = _normalize_trace_flags(trace_flags)
    if not normalized_trace_id or not normalized_span_id or not normalized_trace_flags:
        return ""
    return f"00-{normalized_trace_id}-{normalized_span_id}-{normalized_trace_flags}"


# A valid id matches its hex-length pattern and is not the all-zero sentinel
# (which the regex admits but OTel uses to mean "no id").
def _normalize_id(id_: str | None, pattern: "re.Pattern[str]", zero: str) -> str:
    normalized = (id_ or "").strip().lower()
    if not pattern.match(normalized) or normalized == zero:
        return ""
    return normalized


def _normalize_trace_id(trace_id: str | None) -> str:
    return _normalize_id(trace_id, _TRACE_ID_PATTERN, "00000000000000000000000000000000")


def _normalize_span_id(span_id: str | None) -> str:
    return _normalize_id(span_id, _SPAN_ID_PATTERN, "0000000000000000")


def _normalize_trace_flags(trace_flags: Union[int, str]) -> str:
    if isinstance(trace_flags, int):
        if trace_flags < 0 or trace_flags > 255:
            return ""
        return f"{trace_flags:02x}"
    normalized = trace_flags.strip().lower()
    if not _TRACE_FLAGS_PATTERN.match(normalized):
        return ""
    return normalized
