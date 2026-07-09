export interface TraceparentInput {
  traceId?: string;
  spanId?: string;
  traceFlags?: number | string;
}

const traceIdPattern = /^[0-9a-f]{32}$/;
const spanIdPattern = /^[0-9a-f]{16}$/;
const traceFlagsPattern = /^[0-9a-f]{2}$/;

export function createTraceparent({
  traceId,
  spanId,
  traceFlags = "01",
}: TraceparentInput): string {
  const normalizedTraceId = normalizeTraceId(traceId);
  const normalizedSpanId = normalizeSpanId(spanId);
  const normalizedTraceFlags = normalizeTraceFlags(traceFlags);
  if (!normalizedTraceId || !normalizedSpanId || !normalizedTraceFlags) {
    return "";
  }
  return `00-${normalizedTraceId}-${normalizedSpanId}-${normalizedTraceFlags}`;
}

function normalizeTraceId(traceId: string | undefined): string {
  const normalized = traceId?.trim().toLowerCase() ?? "";
  if (!traceIdPattern.test(normalized)) return "";
  if (normalized === "00000000000000000000000000000000") return "";
  return normalized;
}

function normalizeSpanId(spanId: string | undefined): string {
  const normalized = spanId?.trim().toLowerCase() ?? "";
  if (!spanIdPattern.test(normalized)) return "";
  if (normalized === "0000000000000000") return "";
  return normalized;
}

function normalizeTraceFlags(traceFlags: number | string): string {
  if (typeof traceFlags === "number") {
    if (!Number.isInteger(traceFlags) || traceFlags < 0 || traceFlags > 255) {
      return "";
    }
    return traceFlags.toString(16).padStart(2, "0");
  }
  const normalized = traceFlags.trim().toLowerCase();
  return traceFlagsPattern.test(normalized) ? normalized : "";
}
