import { describe, expect, test } from "bun:test";

import { ConnectionClient } from "./client";
import { ConnectionError } from "./types";

const SERVER = "https://app.astropods.com";

function deployToken(): string {
  const encode = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return [encode({ alg: "HS256", typ: "JWT" }), encode({ sub: "abc-def-ghi", iss: SERVER }), "signature"].join(".");
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function stub(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as string | undefined,
    };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const inAnHour = () => new Date(Date.now() + 3600_000).toISOString();

describe("ConnectionClient.getToken", () => {
  test("posts the user and provider with the deploy token to the token route", async () => {
    const { calls, fetchImpl } = stub(() => json({ access_token: "gho_1", scopes: ["repo"] }));
    const tok = await new ConnectionClient({ identityToken: deployToken(), fetchImpl }).getToken("github", "user_1");

    expect(tok).toEqual({ accessToken: "gho_1", expiresAt: undefined, scopes: ["repo"] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${SERVER}/api/v1/deployments/connections/token`);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${deployToken()}`);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ user_id: "user_1", provider: "github" });
  });

  test("reuses a token until shortly before it expires", async () => {
    const { calls, fetchImpl } = stub(() => json({ access_token: "gho_1", expires_at: inAnHour(), scopes: [] }));
    const client = new ConnectionClient({ identityToken: deployToken(), fetchImpl });
    await client.getToken("github", "user_1");
    await client.getToken("github", "user_1");
    expect(calls).toHaveLength(1);
  });

  test("caches per user, so one user's token never serves another", async () => {
    const { calls, fetchImpl } = stub((call) =>
      json({ access_token: `tok-${JSON.parse(call.body!).user_id}`, expires_at: inAnHour(), scopes: [] }),
    );
    const client = new ConnectionClient({ identityToken: deployToken(), fetchImpl });
    const a = await client.getToken("github", "user_a");
    const b = await client.getToken("github", "user_b");
    expect(a.accessToken).toBe("tok-user_a");
    expect(b.accessToken).toBe("tok-user_b");
    expect(calls).toHaveLength(2);
  });

  test("refetches a token with no expiry every time, so a revoke takes effect", async () => {
    const { calls, fetchImpl } = stub(() => json({ access_token: "gho_1", scopes: [] }));
    const client = new ConnectionClient({ identityToken: deployToken(), fetchImpl });
    await client.getToken("github", "user_1");
    await client.getToken("github", "user_1");
    expect(calls).toHaveLength(2);
  });

  test.each([
    [403, "not_consented"],
    [403, "not_active"],
    [409, "not_connected"],
    [409, "needs_reauthorization"],
  ] as const)("a %i %s refusal surfaces as that code", async (status, code) => {
    const { fetchImpl } = stub(() => json({ error: code }, status));
    const err = await new ConnectionClient({ identityToken: deployToken(), fetchImpl })
      .getToken("github", "user_1")
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConnectionError);
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
  });

  test("an unrecognized refusal is unavailable", async () => {
    const { fetchImpl } = stub(() => json({ error: "token_unavailable" }, 502));
    const err = await new ConnectionClient({ identityToken: deployToken(), fetchImpl })
      .getToken("github", "user_1")
      .catch((e) => e);
    expect(err.code).toBe("unavailable");
  });

  test("an unreachable server is unavailable", async () => {
    const fetchImpl = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const err = await new ConnectionClient({ identityToken: deployToken(), fetchImpl })
      .getToken("github", "user_1")
      .catch((e) => e);
    expect(err.code).toBe("unavailable");
  });

  test("a turn with no user is refused without a request", async () => {
    const { calls, fetchImpl } = stub(() => json({}));
    const err = await new ConnectionClient({ identityToken: deployToken(), fetchImpl })
      .getToken("github", "")
      .catch((e) => e);
    expect(err.code).toBe("not_consented");
    expect(calls).toHaveLength(0);
  });
});

describe("ConnectionClient logging", () => {
  test("never writes the access token to the log", async () => {
    const { logger } = await import("../logger");
    const lines: unknown[] = [];
    const original = { info: logger.info, warn: logger.warn, debug: logger.debug };
    for (const level of ["info", "warn", "debug"] as const) {
      (logger as unknown as Record<string, (...args: unknown[]) => void>)[level] = (...args: unknown[]) => {
        lines.push(args);
      };
    }
    try {
      const { fetchImpl } = stub(() => json({ access_token: "gho_secret_value", scopes: ["repo"] }));
      await new ConnectionClient({ identityToken: deployToken(), fetchImpl }).getToken("github", "user_1");
      const refused = stub(() => json({ error: "not_active" }, 403));
      await new ConnectionClient({ identityToken: deployToken(), fetchImpl: refused.fetchImpl })
        .getToken("github", "user_1")
        .catch(() => {});
    } finally {
      Object.assign(logger, original);
    }
    const logged = JSON.stringify(lines);
    expect(logged).toContain("connections: token issued");
    expect(logged).toContain("connections: token refused");
    expect(logged).toContain("not_active");
    expect(logged).not.toContain("gho_secret_value");
  });
});
