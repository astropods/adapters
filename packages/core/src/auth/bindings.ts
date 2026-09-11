import type { Authorizer } from "./authorizer.js";
import { guard } from "./guard.js";
import type { Principal } from "./types.js";

/**
 * Frameworks are typed structurally so this package depends on none of them.
 */

interface NodeRequest {
  headers: Record<string, string | string[] | undefined>;
  astroPrincipal?: Principal | null;
}

interface NodeResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}

/** Express, Connect, and anything else with a `(req, res, next)` signature. */
export function expressMiddleware(authz: Authorizer) {
  return (req: NodeRequest, res: NodeResponse, next: (err?: unknown) => void) => {
    guard(authz, req.headers)
      .then((outcome) => {
        if (outcome.status !== 200) {
          sendNodeError(res, outcome.status, outcome.message);
          return;
        }
        req.astroPrincipal = outcome.principal;
        next();
      })
      .catch(next);
  };
}

/** Fastify `onRequest` hook. */
export function fastifyHook(authz: Authorizer) {
  return async (
    req: { headers: Record<string, string | string[] | undefined>; astroPrincipal?: Principal | null },
    reply: { code(status: number): { send(body: unknown): unknown } },
  ) => {
    const outcome = await guard(authz, req.headers);
    if (outcome.status !== 200) {
      return reply.code(outcome.status).send({ error: outcome.message });
    }
    req.astroPrincipal = outcome.principal;
    return undefined;
  };
}

/** Hono middleware. Sets `c.set("astroPrincipal", ...)`. */
export function honoMiddleware(authz: Authorizer) {
  return async (
    c: {
      req: { raw: Request };
      set(key: string, value: unknown): void;
      json(body: unknown, status?: number): Response;
    },
    next: () => Promise<void>,
  ) => {
    const outcome = await guard(authz, c.req.raw.headers);
    if (outcome.status !== 200) {
      return c.json({ error: outcome.message }, outcome.status);
    }
    c.set("astroPrincipal", outcome.principal);
    await next();
    return undefined;
  };
}

/**
 * Wraps a Fetch API handler: Next.js route handlers, Hono, Bun.serve, Deno,
 * Cloudflare Workers.
 */
export function withAuth(
  authz: Authorizer,
  handler: (req: Request, principal: Principal | null) => Response | Promise<Response>,
) {
  return async (req: Request): Promise<Response> => {
    const outcome = await guard(authz, req.headers);
    if (outcome.status !== 200) {
      return Response.json({ error: outcome.message }, { status: outcome.status });
    }
    return handler(req, outcome.principal);
  };
}

function sendNodeError(res: NodeResponse, status: number, message: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ error: message }));
}
