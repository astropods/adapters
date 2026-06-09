import type { Server } from "bun";

/**
 * Test HTTP server. Routes:
 *   /status/{code}   → respond with the given status
 *   /echo            → echo method + body
 *   /slow?ms=N       → delay N ms then respond 200
 */
export class TargetServer {
  private server: Server | null = null;

  start(): { url: string } {
    if (this.server) throw new Error("TargetServer already started");
    this.server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname.startsWith("/status/")) {
          const code = Number(url.pathname.slice("/status/".length));
          return new Response(JSON.stringify({ requested: code }), {
            status: code,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.pathname === "/echo") {
          const body = await req.text();
          return Response.json({ method: req.method, body });
        }
        if (url.pathname === "/slow") {
          const ms = Number(url.searchParams.get("ms") ?? "50");
          await new Promise((r) => setTimeout(r, ms));
          return new Response("done");
        }
        return new Response("not found", { status: 404 });
      },
    });
    return { url: `http://127.0.0.1:${this.server.port}` };
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }
}
