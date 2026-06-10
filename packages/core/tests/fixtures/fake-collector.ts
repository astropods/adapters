import type { Server } from "bun";

import { decodeOtlpRequest, type DecodedSpan } from "./span-decoder";

export interface CollectorRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** In-process OTLP HTTP receiver. Records every request; decodes /v1/traces bodies. */
export class FakeCollector {
  private server: Server | null = null;
  public readonly requests: CollectorRequest[] = [];

  start(): { url: string } {
    if (this.server) throw new Error("FakeCollector already started");
    this.server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        const body = new Uint8Array(await req.arrayBuffer());
        this.requests.push({
          url: req.url,
          method: req.method,
          headers: Object.fromEntries(req.headers.entries()),
          body,
        });
        return new Response(null, { status: 200 });
      },
    });
    return { url: `http://127.0.0.1:${this.server.port}` };
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }

  reset(): void {
    this.requests.length = 0;
  }

  spans(): DecodedSpan[] {
    const out: DecodedSpan[] = [];
    for (const req of this.requests) {
      if (!req.url.endsWith("/v1/traces")) continue;
      try {
        out.push(...decodeOtlpRequest(req.body));
      } catch {
        // Skip unparseable bodies.
      }
    }
    return out;
  }
}
