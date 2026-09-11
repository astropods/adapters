import { describe, expect, test } from "bun:test";

import { decodeDeployToken } from "./token";
import { IdentityTokenError } from "./types";

function token(payload: Record<string, unknown>): string {
  const encode = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.signature`;
}

describe("decodeDeployToken", () => {
  test("reads the deployment id, server URL, and open adapters", () => {
    const claims = decodeDeployToken(
      token({
        sub: "dep_123",
        iss: "https://app.astropods.com",
        anyone_adapters: ["web", "custom"],
      }),
    );

    expect(claims.subject).toBe("dep_123");
    expect(claims.issuer).toBe("https://app.astropods.com");
    expect(claims.anyoneAdapters).toEqual(["web", "custom"]);
  });

  test("defaults open adapters to empty when the claim is absent", () => {
    const claims = decodeDeployToken(
      token({ sub: "dep_123", iss: "https://app.astropods.com" }),
    );
    expect(claims.anyoneAdapters).toEqual([]);
  });

  test("rejects a token with no issuer, since it carries the server URL", () => {
    expect(() => decodeDeployToken(token({ sub: "dep_123" }))).toThrow(
      IdentityTokenError,
    );
  });

  test("rejects a structurally invalid token rather than downgrading", () => {
    expect(() => decodeDeployToken("")).toThrow(IdentityTokenError);
    expect(() => decodeDeployToken("not.a.jwt")).toThrow(IdentityTokenError);
    expect(() => decodeDeployToken("onlyonesegment")).toThrow(IdentityTokenError);
  });
});
