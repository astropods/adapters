import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { RenderableResponse } from "@astropods/messaging";

import type {
  AgentAdapter,
  RenderableInput,
  ServeOptions,
  StreamHooks,
} from "./types.js";
import { logger } from "./logger.js";

const DEFAULT_PORT = 8080;

/**
 * SSE event emitted on the AgentCore `/invocations` wire. This is deliberately
 * a distinct format from the messaging web adapter's browser-facing envelope:
 * the invoke transport (messaging's AgentCoreInvokeTransport) translates these
 * back into the same internal ContentChunks the gRPC path produces, so the
 * client-facing wire is unchanged. See specs/P1-wrapper.md §3.
 */
type InvocationEvent =
  | { type: "START" }
  | { type: "DELTA"; content: string }
  | {
      type: "ELICIT";
      renderableId: string;
      message: string;
      dataSchemaJson: string;
      allowedActions: string[];
    }
  | { type: "ERROR"; code: string; message: string }
  | { type: "END" };

/** Body accepted by `POST /invocations`. `resume` present ⇒ elicit continuation. */
interface InvocationRequest {
  prompt?: string;
  sessionId?: string;
  resume?: {
    renderableId: string;
    action: string;
    valueJson?: string;
  };
}

/**
 * AgentCore Runtime transport for an {@link AgentAdapter}, the invoke-per-turn
 * peer of {@link MessagingBridge}. Instead of dialing the messaging gRPC service
 * and holding a bidirectional stream, it serves the AgentCore HTTP contract:
 *
 *   - `GET  /ping`        → `{ "status": "Healthy" }`
 *   - `POST /invocations` → JSON in, SSE out (one turn per request)
 *
 * The adapter and its hooks are unchanged — only the wire under `serve()` swaps.
 * Selected by `ASTRO_RUNTIME=agentcore`; the default (gRPC) path is untouched.
 */
export class AgentCoreServer {
  private adapter: AgentAdapter;
  private port: number;
  private server: Server | null = null;
  private shutdownHandler: (() => void) | null = null;
  // Live awaiters for blocking Renderables, keyed by Renderable.id. In-process
  // only; cross-invoke continuation rests on the adapter's onResume hook.
  private pendingRenderables = new Map<
    string,
    {
      resolve: (r: RenderableResponse) => void;
      reject: (e: Error) => void;
    }
  >();

  constructor(adapter: AgentAdapter, options?: ServeOptions) {
    this.adapter = adapter;
    // Reuse serverAddress as a port override only if it is a bare number;
    // otherwise honor PORT (AgentCore sets none — 8080 is the contract default).
    const portEnv = process.env.PORT;
    this.port = portEnv ? Number(portEnv) : DEFAULT_PORT;
  }

  async start(): Promise<void> {
    const agentName = this.adapter.name;
    logger.info(`Starting ${agentName} (AgentCore runtime mode)...`);
    logger.info(`  HTTP: 0.0.0.0:${this.port}`);

    this.server = createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        logger.error({ err: error }, "Unhandled request error");
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "internal error" }));
        }
      });
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(this.port, "0.0.0.0", () => resolve());
    });

    logger.info(`${agentName} is ready on :${this.port} (POST /invocations, GET /ping)`);

    this.shutdownHandler = () => {
      logger.info("Shutting down...");
      this.stop();
      process.exit(0);
    };
    process.on("SIGINT", this.shutdownHandler);
    process.on("SIGTERM", this.shutdownHandler);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "/";
    if (req.method === "GET" && url.startsWith("/ping")) {
      res.writeHead(200, { "content-type": "application/json" });
      // Invoke-per-turn holds nothing open, so a plain Healthy is correct. We do
      // NOT set time_of_last_update — advancing it on every ping would defeat the
      // runtime's idle-session timeout (see the AgentCore HTTP contract).
      res.end(JSON.stringify({ status: "Healthy" }));
      return;
    }

    if (req.method === "POST" && url.startsWith("/invocations")) {
      const body = await this.readJson(req);
      await this.handleInvocation(body, res);
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  }

  private async readJson(req: IncomingMessage): Promise<InvocationRequest> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw) return {};
    try {
      return JSON.parse(raw) as InvocationRequest;
    } catch {
      throw new Error("invalid JSON body");
    }
  }

  private async handleInvocation(
    body: InvocationRequest,
    res: ServerResponse
  ): Promise<void> {
    const conversationId = body.sessionId || randomUUID();
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    const send = (event: InvocationEvent) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // A resume invoke continues a turn that yielded on a blocking Renderable:
    // route it to the adapter's onResume rather than starting a fresh turn.
    if (body.resume) {
      const { renderableId, action, valueJson } = body.resume;
      const response: RenderableResponse = {
        id: renderableId,
        action: action as RenderableResponse["action"],
        valueJson,
      } as RenderableResponse;

      const waiter = this.pendingRenderables.get(renderableId);
      if (waiter) {
        this.pendingRenderables.delete(renderableId);
        waiter.resolve(response);
      } else if (this.adapter.onResume) {
        try {
          await this.adapter.onResume(conversationId, response);
        } catch (err) {
          logger.error({ err }, "onResume threw");
        }
      } else {
        logger.warn(
          `Resume for ${renderableId} has no awaiter and no onResume handler; dropping`
        );
      }
      send({ type: "END" });
      res.end();
      return;
    }

    const prompt = body.prompt ?? "";
    const controller = new AbortController();
    res.on("close", () => controller.abort());

    const hooks = this.buildHooks(send);
    send({ type: "START" });

    try {
      await this.adapter.stream(prompt, hooks, {
        conversationId,
        userId: "agentcore",
        signal: controller.signal,
        render: (input) => this.sendRenderable(send, input),
        elicit: (message, dataSchema, opts) =>
          this.sendRenderable(send, {
            message,
            dataSchema,
            ...opts,
          }),
      });
    } catch (error) {
      hooks.onError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      res.end();
    }
  }

  /**
   * Build the StreamHooks the adapter drives, mapping each to an SSE event. The
   * subset mirrors MessagingBridge.buildHooks: onChunk→DELTA, onFinish→END,
   * onError→ERROR. Audio/transcript/status are no-ops on the invoke wire in v1.
   */
  private buildHooks(send: (event: InvocationEvent) => void): StreamHooks {
    return {
      onChunk: (text: string) => send({ type: "DELTA", content: text }),
      onFinish: () => send({ type: "END" }),
      onError: (error: Error) => {
        logger.error({ err: error }, "Agent error");
        send({ type: "ERROR", code: "AGENT_ERROR", message: error.message });
      },
      onStatusUpdate: () => {},
      onTranscript: () => {},
      onAudioChunk: () => {},
      onAudioEnd: () => {},
      // File outputs are a no-op on the invoke wire in v1, mirroring the other
      // non-content hooks above.
      onFile: () => {},
    };
  }

  /**
   * Emit an ELICIT event and end the turn's SSE stream. The awaiting promise is
   * held so a subsequent `resume` invoke (routed via onResume) can settle it;
   * the returned promise resolves when that continuation arrives.
   */
  private sendRenderable(
    send: (event: InvocationEvent) => void,
    input: RenderableInput
  ): Promise<RenderableResponse> {
    return new Promise<RenderableResponse>((resolve, reject) => {
      const id = input.id || randomUUID();
      this.pendingRenderables.set(id, { resolve, reject });
      send({
        type: "ELICIT",
        renderableId: id,
        message: input.message,
        dataSchemaJson: JSON.stringify(input.dataSchema),
        allowedActions: (input.allowedActions ?? [
          "RENDERABLE_ACTION_SUBMIT",
          "RENDERABLE_ACTION_CANCEL",
        ]) as string[],
      });
    });
  }

  stop(): void {
    for (const waiter of this.pendingRenderables.values()) {
      waiter.reject(new Error("AgentCore server stopped before the interaction was answered"));
    }
    this.pendingRenderables.clear();

    if (this.shutdownHandler) {
      process.removeListener("SIGINT", this.shutdownHandler);
      process.removeListener("SIGTERM", this.shutdownHandler);
      this.shutdownHandler = null;
    }
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}
