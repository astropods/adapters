import { importSPKI, jwtVerify, decodeProtectedHeader } from "jose";

import type { Principal } from "./types.js";

export const IDENTITY_HEADER = "x-amzn-oidc-identity";
export const DATA_HEADER = "x-amzn-oidc-data";
export const ACCESS_TOKEN_HEADER = "x-amzn-oidc-accesstoken";

export interface AlbIdentityVerifierOptions {
  region?: string;
  /** Overridable for tests. Returns a PEM-encoded SPKI public key. */
  fetchKey?: (kid: string, region: string) => Promise<string>;
}

/**
 * Verifies the signed claims JWT the ALB injects on authenticated requests.
 *
 * ALB puts `exp` in the JWT *header*, not the payload, and the payload holds
 * only the IdP's user claims. Expiry is therefore checked against the header.
 */
export class AlbIdentityVerifier {
  private readonly keys = new Map<string, CryptoKey>();
  private readonly region?: string;
  private readonly fetchKey: (kid: string, region: string) => Promise<string>;

  constructor(options: AlbIdentityVerifierOptions = {}) {
    this.region = options.region;
    this.fetchKey = options.fetchKey ?? fetchAlbPublicKey;
  }

  async verify(data: string): Promise<Principal> {
    const header = decodeProtectedHeader(data) as {
      kid?: string;
      signer?: string;
      exp?: number;
      alg?: string;
    };

    if (header.alg !== "ES256") {
      throw new Error(`alb identity: unexpected alg ${header.alg}`);
    }
    if (!header.kid) {
      throw new Error("alb identity: header missing kid");
    }
    if (typeof header.exp === "number" && header.exp * 1000 <= Date.now()) {
      throw new Error("alb identity: token expired");
    }

    const region = this.region ?? regionFromSignerArn(header.signer);
    if (!region) {
      throw new Error("alb identity: cannot determine region for key lookup");
    }

    const key = await this.keyFor(header.kid, region);
    const { payload } = await jwtVerify(data, key, { algorithms: ["ES256"] });

    const userId = typeof payload.sub === "string" ? payload.sub : "";
    if (!userId) {
      throw new Error("alb identity: payload missing sub");
    }

    return {
      userId,
      email: typeof payload.email === "string" ? payload.email : undefined,
      name: typeof payload.name === "string" ? payload.name : undefined,
      source: "alb",
      claims: payload as Record<string, unknown>,
    };
  }

  private async keyFor(kid: string, region: string): Promise<CryptoKey> {
    const cached = this.keys.get(kid);
    if (cached) return cached;
    const pem = await this.fetchKey(kid, region);
    const key = await importSPKI(pem, "ES256");
    this.keys.set(kid, key);
    return key;
  }
}

export function regionFromSignerArn(arn: string | undefined): string | undefined {
  if (!arn) return undefined;
  const parts = arn.split(":");
  return parts.length > 3 && parts[3] ? parts[3] : undefined;
}

async function fetchAlbPublicKey(kid: string, region: string): Promise<string> {
  const url = `https://public-keys.auth.elb.${region}.amazonaws.com/${encodeURIComponent(kid)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`alb identity: key fetch returned ${res.status}`);
  }
  return res.text();
}
