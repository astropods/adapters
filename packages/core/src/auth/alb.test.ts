import { describe, expect, test } from "bun:test";
import { SignJWT, exportSPKI, generateKeyPair } from "jose";

import { AlbIdentityVerifier, regionFromSignerArn } from "./alb";

const SIGNER =
  "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/router/abc123";

const { publicKey, privateKey } = await generateKeyPair("ES256", {
  extractable: true,
});
const pem = await exportSPKI(publicKey);
const other = await generateKeyPair("ES256", { extractable: true });

/** Mirrors the ALB's layout: user claims in the payload, `exp` in the header. */
async function albToken(
  over: {
    claims?: Record<string, unknown>;
    header?: Record<string, unknown>;
    key?: CryptoKey;
  } = {},
): Promise<string> {
  return new SignJWT(over.claims ?? { sub: "user_1", email: "a@b.com" })
    .setProtectedHeader({
      alg: "ES256",
      kid: "kid-1",
      signer: SIGNER,
      exp: Math.floor(Date.now() / 1000) + 600,
      ...over.header,
    })
    .sign(over.key ?? (privateKey as CryptoKey));
}

function verifier(key = pem) {
  return new AlbIdentityVerifier({ fetchKey: async () => key });
}

describe("AlbIdentityVerifier", () => {
  test("returns the caller's identity from a well-formed token", async () => {
    const p = await verifier().verify(await albToken());
    expect(p).toMatchObject({
      userId: "user_1",
      email: "a@b.com",
      source: "alb",
    });
  });

  test("rejects a token signed by a key that is not the ALB's", async () => {
    const forged = await albToken({ key: other.privateKey as CryptoKey });
    expect(verifier().verify(forged)).rejects.toThrow();
  });

  test("rejects a tampered payload", async () => {
    const [h, , s] = (await albToken()).split(".");
    const swapped = Buffer.from(JSON.stringify({ sub: "user_admin" })).toString(
      "base64url",
    );
    expect(verifier().verify(`${h}.${swapped}.${s}`)).rejects.toThrow();
  });

  test("rejects a token whose header expiry has passed", async () => {
    const expired = await albToken({
      header: { exp: Math.floor(Date.now() / 1000) - 1 },
    });
    expect(verifier().verify(expired)).rejects.toThrow("expired");
  });

  test("rejects an algorithm downgrade", async () => {
    const token = await albToken();
    const [, p, s] = token.split(".");
    const header = Buffer.from(
      JSON.stringify({ alg: "none", kid: "kid-1", signer: SIGNER }),
    ).toString("base64url");
    expect(verifier().verify(`${header}.${p}.${s}`)).rejects.toThrow(
      "unexpected alg",
    );
  });

  test("rejects a token with no key id to look up", async () => {
    const token = await albToken();
    const [, p, s] = token.split(".");
    const header = Buffer.from(
      JSON.stringify({ alg: "ES256", signer: SIGNER }),
    ).toString("base64url");
    expect(verifier().verify(`${header}.${p}.${s}`)).rejects.toThrow("kid");
  });

  test("rejects a token carrying no subject to authorize", async () => {
    const noSub = await albToken({ claims: { email: "a@b.com" } });
    expect(verifier().verify(noSub)).rejects.toThrow("sub");
  });

  test("fetches each key once and reuses it", async () => {
    let fetches = 0;
    const v = new AlbIdentityVerifier({
      fetchKey: async () => {
        fetches += 1;
        return pem;
      },
    });
    await v.verify(await albToken());
    await v.verify(await albToken());
    expect(fetches).toBe(1);
  });

  test("fails when no region can be determined for the key lookup", async () => {
    const noSigner = await albToken({ header: { signer: undefined } });
    expect(verifier().verify(noSigner)).rejects.toThrow("region");
  });
});

describe("regionFromSignerArn", () => {
  test("reads the region out of a load balancer ARN", () => {
    expect(regionFromSignerArn(SIGNER)).toBe("us-east-1");
  });

  test("returns undefined for a missing or malformed ARN", () => {
    expect(regionFromSignerArn(undefined)).toBeUndefined();
    expect(regionFromSignerArn("not-an-arn")).toBeUndefined();
    expect(regionFromSignerArn("arn:aws:elb::123:lb")).toBeUndefined();
  });
});
