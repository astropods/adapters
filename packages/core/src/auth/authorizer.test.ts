import { describe, expect, test } from "bun:test";

import { Authorizer } from "./authorizer";
import { guard } from "./guard";
import { AuthorizeUnavailableError } from "./types";

const SERVER = "https://app.astropods.com";

function deployToken(anyoneAdapters: string[] = []): string {
  const encode = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return [
    encode({ alg: "HS256", typ: "JWT" }),
    encode({ sub: "dep_1", iss: SERVER, anyone_adapters: anyoneAdapters }),
    "signature",
  ].join(".");
}

interface StubCall {
  url: URL;
  authorization: string | null;
}

function stubServer(
  responses: Array<{ allowed: boolean; user_id?: string } | Error>,
) {
  const calls: StubCall[] = [];
  let i = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: new URL(String(input)),
      authorization: new Headers(init?.headers).get("authorization"),
    });
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function authorizer(
  over: { anyoneAdapters?: string[]; responses?: Array<{ allowed: boolean; user_id?: string } | Error> } = {},
) {
  const stub = stubServer(over.responses ?? [{ allowed: true, user_id: "user_1" }]);
  const authz = new Authorizer({
    identityToken: deployToken(over.anyoneAdapters),
    fetchImpl: stub.fetchImpl,
    verifyIdentity: false,
  });
  return { authz, ...stub };
}

const principal = { userId: "user_1", source: "alb" as const, claims: {} };

describe("Authorizer.identify", () => {
  test("reads the user id the front door injected", async () => {
    const { authz } = authorizer();
    const p = await authz.identify({ "x-amzn-oidc-identity": "user_1" });
    expect(p).toEqual({ userId: "user_1", source: "alb", claims: {} });
  });

  test("matches the identity header case-insensitively", async () => {
    const { authz } = authorizer();
    const p = await authz.identify({ "X-Amzn-Oidc-Identity": "user_1" });
    expect(p?.userId).toBe("user_1");
  });

  test("returns null when the request carries no identity", async () => {
    const { authz } = authorizer();
    expect(await authz.identify({})).toBeNull();
  });

  test("returns the configured identity in dev mode", async () => {
    const authz = new Authorizer({ identityToken: "", devUserId: "user_dev" });
    const p = await authz.identify({});
    expect(p).toEqual({ userId: "user_dev", source: "fixed", claims: {} });
  });
});

describe("Authorizer.authorize", () => {
  test("allows a principal the server grants, and reports the resolved user id", async () => {
    const { authz } = authorizer();
    expect(await authz.authorize(principal)).toEqual({
      allowed: true,
      userId: "user_1",
    });
  });

  test("denies a principal the server rejects", async () => {
    const { authz } = authorizer({ responses: [{ allowed: false }] });
    expect(await authz.authorize(principal)).toEqual({
      allowed: false,
      userId: undefined,
    });
  });

  test("authorizes against the custom adapter by default", async () => {
    const { authz, calls } = authorizer();
    await authz.authorize(principal);
    expect(calls[0]!.url.searchParams.get("adapter")).toBe("custom");
    expect(calls[0]!.url.searchParams.get("identity_type")).toBe("user");
    expect(calls[0]!.url.searchParams.get("identity_id")).toBe("user_1");
    expect(calls[0]!.url.pathname).toBe("/api/v1/deployments/authorize");
  });

  test("presents the deploy token as the bearer credential", async () => {
    const { authz, calls } = authorizer();
    await authz.authorize(principal);
    expect(calls[0]!.authorization).toBe(`Bearer ${deployToken()}`);
  });

  test("sends no identity for an anonymous caller, leaving anyone-grants to the server", async () => {
    const { authz, calls } = authorizer();
    await authz.authorize(null);
    expect(calls[0]!.url.searchParams.has("identity_type")).toBe(false);
    expect(calls[0]!.url.searchParams.has("identity_id")).toBe(false);
  });

  test("serves a repeat check from cache instead of calling the server again", async () => {
    const { authz, calls } = authorizer();
    await authz.authorize(principal);
    await authz.authorize(principal);
    expect(calls).toHaveLength(1);
  });

  test("fails closed when the server is unreachable and no adapter is open", async () => {
    const { authz } = authorizer({ responses: [new Error("connection refused")] });
    await expect(authz.authorize(principal)).rejects.toBeInstanceOf(
      AuthorizeUnavailableError,
    );
  });

  test("does not cache a transport failure, so the next request retries", async () => {
    const { authz, calls } = authorizer({
      responses: [new Error("connection refused"), new Error("connection refused")],
    });
    await expect(authz.authorize(principal)).rejects.toThrow();
    await expect(authz.authorize(principal)).rejects.toThrow();
    expect(calls).toHaveLength(2);
  });

  test("stays up during a server outage when the adapter has an anyone grant", async () => {
    const { authz } = authorizer({
      anyoneAdapters: ["custom"],
      responses: [new Error("connection refused")],
    });
    expect(await authz.authorize(principal)).toEqual({ allowed: true });
  });

  test("treats a non-200 from the server as unavailable, not as a denial", async () => {
    const fetchImpl = (async () => new Response("", { status: 500 })) as typeof fetch;
    const authz = new Authorizer({ identityToken: deployToken(), fetchImpl });
    await expect(authz.authorize(principal)).rejects.toBeInstanceOf(
      AuthorizeUnavailableError,
    );
  });

  test("allows everything in dev mode without calling the server", async () => {
    const authz = new Authorizer({ identityToken: "" });
    expect(authz.devMode).toBe(true);
    expect(await authz.authorize(null)).toEqual({
      allowed: true,
      userId: undefined,
    });
  });
});

describe("guard", () => {
  test("passes an allowed caller through with their principal", async () => {
    const { authz } = authorizer();
    const outcome = await guard(authz, { "x-amzn-oidc-identity": "user_1" });
    expect(outcome.status).toBe(200);
    expect(outcome.principal?.userId).toBe("user_1");
  });

  test("answers 401 when the request carries no identity", async () => {
    const { authz } = authorizer();
    expect((await guard(authz, {})).status).toBe(401);
  });

  test("answers 403 when the deployment's grants exclude the caller", async () => {
    const { authz } = authorizer({ responses: [{ allowed: false }] });
    const outcome = await guard(authz, { "x-amzn-oidc-identity": "user_1" });
    expect(outcome.status).toBe(403);
  });

  test("answers 503 when the authorize call cannot complete", async () => {
    const { authz } = authorizer({ responses: [new Error("connection refused")] });
    const outcome = await guard(authz, { "x-amzn-oidc-identity": "user_1" });
    expect(outcome.status).toBe(503);
  });
});
