import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Authorizer } from "./authorizer";
import { guard } from "./guard";
import { decodeDeployToken } from "./token";

/**
 * Drives the same fixture file as packages/core-py/tests/test_auth_parity.py.
 * A behavior change in one language fails here until the other follows.
 */

interface TokenCase {
  name: string;
  token: string;
  expect?: { subject: string; issuer: string; anyoneAdapters: string[] };
  expectError?: boolean;
}

interface GuardCase {
  name: string;
  anyoneAdapters: string[];
  headers: Record<string, string>;
  server: { allowed: boolean; user_id?: string } | "error" | "status500";
  expectStatus: number;
  expectUserId?: string;
}

interface RequestCase {
  name: string;
  userId: string | null;
  expectParams: Record<string, string>;
}

const fixture = JSON.parse(
  readFileSync(
    join(import.meta.dir, "../../../../test-data/auth-parity.json"),
    "utf8",
  ),
) as {
  deployToken: TokenCase[];
  guard: GuardCase[];
  authorizeRequest: { cases: RequestCase[] };
};

function serverStub(server: GuardCase["server"]) {
  const calls: URL[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    calls.push(new URL(String(input)));
    if (server === "error") throw new Error("connection refused");
    if (server === "status500") return new Response("", { status: 500 });
    return new Response(JSON.stringify(server), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function tokenFor(anyoneAdapters: string[]): string {
  const encode = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return [
    encode({ alg: "HS256", typ: "JWT" }),
    encode({
      sub: "dep_1",
      iss: "https://app.astropods.com",
      anyone_adapters: anyoneAdapters,
    }),
    "signature",
  ].join(".");
}

describe("parity: deploy token decoding", () => {
  for (const c of fixture.deployToken) {
    test(c.name, () => {
      if (c.expectError) {
        expect(() => decodeDeployToken(c.token)).toThrow();
        return;
      }
      const claims = decodeDeployToken(c.token);
      expect(claims.subject).toBe(c.expect!.subject);
      expect(claims.issuer).toBe(c.expect!.issuer);
      expect(claims.anyoneAdapters).toEqual(c.expect!.anyoneAdapters);
    });
  }
});

describe("parity: guard outcomes", () => {
  for (const c of fixture.guard) {
    test(c.name, async () => {
      const { fetchImpl } = serverStub(c.server);
      const authz = new Authorizer({
        identityToken: tokenFor(c.anyoneAdapters),
        fetchImpl,
        verifyIdentity: false,
      });

      const outcome = await guard(authz, c.headers);
      expect(outcome.status).toBe(c.expectStatus);
      if (c.expectUserId !== undefined) {
        expect(outcome.principal?.userId).toBe(c.expectUserId);
      }
    });
  }
});

describe("parity: authorize request shape", () => {
  for (const c of fixture.authorizeRequest.cases) {
    test(c.name, async () => {
      const { calls, fetchImpl } = serverStub({ allowed: true });
      const authz = new Authorizer({
        identityToken: tokenFor([]),
        fetchImpl,
        verifyIdentity: false,
      });

      await authz.authorize(
        c.userId ? { userId: c.userId, source: "alb", claims: {} } : null,
      );

      const params = Object.fromEntries(calls[0]!.searchParams.entries());
      expect(params).toEqual(c.expectParams);
    });
  }
});
