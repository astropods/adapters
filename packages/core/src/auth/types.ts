/** Who the caller is, once an identity source has produced one. */
export interface Principal {
  userId: string;
  email?: string;
  name?: string;
  source: "alb" | "fixed";
  claims: Record<string, unknown>;
}

/** The server's answer to "may this principal use this deployment?". */
export interface Decision {
  allowed: boolean;
  /** Canonical WorkOS user id, populated by the server only when allowed. */
  userId?: string;
}

export type HeaderLike =
  | Headers
  | Map<string, string>
  | Record<string, string | string[] | undefined>;

export interface AuthorizerOptions {
  /** Raw ASTRO_AUTHZ_TOKEN. Absent (and absent from env) selects dev mode. */
  identityToken?: string;
  /** Adapter to authorize against. */
  adapter?: string;
  /** Decision cache TTL, seconds. */
  cacheTtlSeconds?: number;
  /** Per-request timeout, seconds. */
  timeoutSeconds?: number;
  /** Verify the signature on x-amzn-oidc-data. */
  verifyIdentity?: boolean;
  /** Region for the ALB public key endpoint. Read from the signer ARN when absent. */
  region?: string;
  /** Identity returned in dev mode. */
  devUserId?: string;
  /** Overridable transport, for tests. */
  fetchImpl?: typeof fetch;
}

export class AuthorizeUnavailableError extends Error {
  constructor(cause: unknown) {
    super("authorize call failed");
    this.name = "AuthorizeUnavailableError";
    this.cause = cause;
  }
}

export class IdentityTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityTokenError";
  }
}

export function normalizeHeaders(headers: HeaderLike): Map<string, string> {
  const out = new Map<string, string>();
  const set = (key: string, value: string | string[] | undefined) => {
    if (value === undefined) return;
    out.set(key.toLowerCase(), Array.isArray(value) ? (value[0] ?? "") : value);
  };
  if (typeof (headers as Headers).forEach === "function" && !Array.isArray(headers)) {
    (headers as Headers).forEach((value: string, key: string) => set(key, value));
    return out;
  }
  for (const [key, value] of Object.entries(headers as Record<string, string>)) {
    set(key, value);
  }
  return out;
}
