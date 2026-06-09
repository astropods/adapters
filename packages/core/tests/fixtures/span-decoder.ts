export interface DecodedSpan {
  name: string;
  kind: number;
  traceId: string;
  spanId: string;
  parentSpanId: string;
  status?: { code?: number; message?: string };
  attributes: Record<string, string | number | boolean>;
  events: Array<{ name: string; attributes: Record<string, string | number | boolean> }>;
  scopeName: string;
  resourceAttributes: Record<string, string | number | boolean>;
}

/** Decode an OTLP-JSON `ExportTraceServiceRequest` body into a flat span list. */
export function decodeOtlpRequest(body: Uint8Array): DecodedSpan[] {
  const text = new TextDecoder().decode(body);
  const obj = JSON.parse(text) as any;

  const spans: DecodedSpan[] = [];
  for (const rs of obj.resourceSpans ?? []) {
    const resourceAttributes = flattenAttributes(rs.resource?.attributes ?? []);
    for (const ss of rs.scopeSpans ?? []) {
      const scopeName = ss.scope?.name ?? "";
      for (const s of ss.spans ?? []) {
        const events = (s.events ?? []).map((e: any) => ({
          name: e.name,
          attributes: flattenAttributes(e.attributes ?? []),
        }));
        spans.push({
          name: s.name,
          kind: s.kind ?? 0,
          traceId: s.traceId ?? "",
          spanId: s.spanId ?? "",
          parentSpanId: s.parentSpanId ?? "",
          status: s.status,
          attributes: flattenAttributes(s.attributes ?? []),
          events,
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
