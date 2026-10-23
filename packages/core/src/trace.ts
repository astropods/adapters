import { randomBytes } from "node:crypto";

export interface TraceparentInput {
  traceId?: string;
  spanId?: string;
  traceFlags?: number | string;
}

/** A W3C-shaped trace id (32 hex) and span id (16 hex). */
export interface TraceIds {
  traceId: string;
  spanId: string;
}

/**
 * Mints a fresh W3C-shaped trace and span id.
 *
 * For a framework that keeps its own tracing rather than the OTel globals
 * (Mastra, via `@mastra/observability`), there is nothing for
 * `propagation.inject` to read, so the ids have to come from somewhere. Minting
 * them here and handing the same pair to both the framework and the gateway
 * request is what puts the agent's trace and its billed records on one trace
 * id. See billed-vs-estimated-cost-spec.md, open question 2.
 */
export function newTraceIds(): TraceIds {
  return {
    traceId: randomHex(16),
    spanId: randomHex(8),
  };
}

function randomHex(bytes: number): string {
  return Array.from(randomBytes(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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

// A valid id matches its hex-length pattern and is not the all-zero sentinel
// (which the regex admits but OTel uses to mean "no id").
function normalizeId(id: string | undefined, pattern: RegExp, zero: string): string {
  const normalized = id?.trim().toLowerCase() ?? "";
  if (!pattern.test(normalized) || normalized === zero) return "";
  return normalized;
}

function normalizeTraceId(traceId: string | undefined): string {
  return normalizeId(traceId, traceIdPattern, "00000000000000000000000000000000");
}

function normalizeSpanId(spanId: string | undefined): string {
  return normalizeId(spanId, spanIdPattern, "0000000000000000");
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
