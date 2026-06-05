export interface DecodedSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId: string;
  attributes: Record<string, string | number | boolean>;
  scopeName: string;
  resourceAttributes: Record<string, string | number | boolean>;
}

/**
 * Decode an OTLP-JSON `ExportTraceServiceRequest` body (as received by an
 * OTLP HTTP/JSON collector) into a flat list of spans with resolved
 * attributes. `@opentelemetry/exporter-trace-otlp-http` sends JSON by
 * default; the protobuf flavor lives in `@opentelemetry/exporter-trace-otlp-proto`.
 */
export function decodeOtlpRequest(body: Uint8Array): DecodedSpan[] {
  const text = new TextDecoder().decode(body);
  const obj = JSON.parse(text) as any;

  const spans: DecodedSpan[] = [];
  for (const rs of obj.resourceSpans ?? []) {
    const resourceAttributes = flattenAttributes(rs.resource?.attributes ?? []);
    for (const ss of rs.scopeSpans ?? []) {
      const scopeName = ss.scope?.name ?? "";
      for (const s of ss.spans ?? []) {
        spans.push({
          name: s.name,
          traceId: s.traceId ?? "",
          spanId: s.spanId ?? "",
          parentSpanId: s.parentSpanId ?? "",
          attributes: flattenAttributes(s.attributes ?? []),
          scopeName,
          resourceAttributes,
        });
      }
    }
  }
  return spans;
}

function flattenAttributes(
  attrs: Array<{ key: string; value: any }>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const attr of attrs) {
    const v = attr.value;
    if (v.stringValue !== undefined) out[attr.key] = v.stringValue;
    else if (v.boolValue !== undefined) out[attr.key] = v.boolValue;
    else if (v.intValue !== undefined) out[attr.key] = Number(v.intValue);
    else if (v.doubleValue !== undefined) out[attr.key] = v.doubleValue;
  }
  return out;
}
