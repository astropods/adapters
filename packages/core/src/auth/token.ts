import { IdentityTokenError } from "./types.js";

export interface DeployTokenClaims {
  /** Deployment id. */
  subject: string;
  /** astro-server's base URL. */
  issuer: string;
  anyoneAdapters: string[];
}

/**
 * Decodes ASTRO_AUTHZ_TOKEN without verifying its signature. The container has
 * no access to the signing secret; the authorize endpoint is the authority on
 * every call.
 */
export function decodeDeployToken(raw: string): DeployTokenClaims {
  if (!raw) throw new IdentityTokenError("identity token is empty");

  const parts = raw.split(".");
  if (parts.length !== 3) {
    throw new IdentityTokenError(
      `identity token: expected 3 segments, got ${parts.length}`,
    );
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch (err) {
    throw new IdentityTokenError(`identity token payload: ${String(err)}`);
  }

  const subject = typeof payload.sub === "string" ? payload.sub : "";
  const issuer = typeof payload.iss === "string" ? payload.iss : "";
  if (!issuer) {
    throw new IdentityTokenError("identity token missing iss claim (server URL)");
  }

  const anyoneAdapters = Array.isArray(payload.anyone_adapters)
    ? payload.anyone_adapters.filter((a): a is string => typeof a === "string")
    : [];

  return { subject, issuer, anyoneAdapters };
}
