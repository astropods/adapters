import { logger } from "../logger.js";
import { AlbIdentityVerifier, DATA_HEADER, IDENTITY_HEADER } from "./alb.js";
import { AuthorizeClient } from "./client.js";
import { DecisionCache } from "./cache.js";
import { decodeDeployToken } from "./token.js";
import {
  AuthorizeUnavailableError,
  normalizeHeaders,
  type AuthorizerOptions,
  type Decision,
  type HeaderLike,
  type Principal,
} from "./types.js";

export const DEFAULT_ADAPTER = "custom";
export const DEFAULT_CACHE_TTL_SECONDS = 60;
export const DEFAULT_TIMEOUT_SECONDS = 5;
export const DEGRADED_CACHE_TTL_SECONDS = 10;

const IDENTITY_TYPE_USER = "user";

/**
 * Answers "who is calling, and may they use this deployment?" for an agent
 * serving its own HTTP surface.
 */
export class Authorizer {
  readonly deploymentId: string;
  readonly adapter: string;
  private readonly anyoneAdapters: string[];
  private readonly client?: AuthorizeClient;
  private readonly cache: DecisionCache;
  private readonly verifier?: AlbIdentityVerifier;
  private readonly devUserId?: string;
  private readonly cacheTtlMs: number;

  constructor(options: AuthorizerOptions = {}) {
    const token = options.identityToken ?? process.env.ASTRO_AUTHZ_TOKEN ?? "";
    this.adapter =
      options.adapter ?? process.env.ASTRO_AUTH_ADAPTER ?? DEFAULT_ADAPTER;
    this.cacheTtlMs =
      seconds(options.cacheTtlSeconds, "ASTRO_AUTH_CACHE_TTL", DEFAULT_CACHE_TTL_SECONDS) *
      1000;
    this.cache = new DecisionCache(this.cacheTtlMs);
    this.devUserId = options.devUserId ?? process.env.ASTRO_AUTH_DEV_USER_ID;

    if (!token) {
      this.deploymentId = "";
      this.anyoneAdapters = [];
      logger.warn(
        "auth: authorization disabled, ASTRO_AUTHZ_TOKEN not set (dev mode, all requests allowed)",
      );
      return;
    }

    const claims = decodeDeployToken(token);
    this.deploymentId = claims.subject;
    this.anyoneAdapters = claims.anyoneAdapters;

    const timeoutMs =
      seconds(options.timeoutSeconds, "ASTRO_AUTH_TIMEOUT", DEFAULT_TIMEOUT_SECONDS) *
      1000;
    this.client = new AuthorizeClient(
      claims.issuer,
      token,
      timeoutMs,
      options.fetchImpl,
    );

    const verify = options.verifyIdentity ?? true;
    if (verify) {
      this.verifier = new AlbIdentityVerifier({
        region: options.region ?? process.env.AWS_REGION,
      });
    } else {
      logger.warn(
        "auth: x-amzn-oidc-data signature verification disabled by configuration",
      );
    }

    logger.info(
      {
        deployment_id: this.deploymentId,
        server_url: claims.issuer,
        adapter: this.adapter,
        anyone_adapters: this.anyoneAdapters,
      },
      "auth: authorizer initialized",
    );
  }

  /** True when no deploy token was supplied, so every request is allowed. */
  get devMode(): boolean {
    return this.client === undefined;
  }

  /**
   * Resolves the caller from the front door's identity headers. Returns null
   * when no identity is present, or when a present one fails verification.
   */
  async identify(headers: HeaderLike): Promise<Principal | null> {
    const h = normalizeHeaders(headers);

    if (this.devMode) {
      return this.devUserId
        ? { userId: this.devUserId, source: "fixed", claims: {} }
        : null;
    }

    const data = h.get(DATA_HEADER);
    if (data && this.verifier) {
      try {
        return await this.verifier.verify(data);
      } catch (err) {
        logger.warn({ err }, "auth: identity header verification failed");
        return null;
      }
    }

    const identity = h.get(IDENTITY_HEADER);
    if (!identity) return null;
    return { userId: identity, source: "alb", claims: {} };
  }

  /**
   * Checks the principal against the deployment's grants. A null principal is
   * sent as an anonymous request, which the server allows only under an
   * `anyone` grant.
   */
  async authorize(principal: Principal | null): Promise<Decision> {
    if (!this.client) {
      return { allowed: true, userId: principal?.userId };
    }

    const key = {
      identityType: principal ? IDENTITY_TYPE_USER : "",
      identityId: principal?.userId ?? "",
      adapter: this.adapter,
      identityScope: "",
    };

    const cached = this.cache.get(key);
    if (cached) return cached;

    let decision: Decision;
    try {
      decision = await this.client.authorize(key);
    } catch (err) {
      if (this.anyoneAdapters.includes(this.adapter)) {
        logger.warn(
          { err, adapter: this.adapter },
          "auth: authorize call failed, serving via anyone-adapters token claim",
        );
        const degraded: Decision = { allowed: true };
        this.cache.set(key, degraded, DEGRADED_CACHE_TTL_SECONDS * 1000);
        return degraded;
      }
      logger.warn(
        { err, adapter: this.adapter },
        "auth: authorize call failed",
      );
      throw err instanceof AuthorizeUnavailableError
        ? err
        : new AuthorizeUnavailableError(err);
    }

    this.cache.set(key, decision);
    if (!decision.allowed) {
      logger.warn({ adapter: this.adapter }, "auth: authorize denied");
    }
    return decision;
  }
}

function seconds(
  explicit: number | undefined,
  envName: string,
  fallback: number,
): number {
  if (explicit !== undefined && explicit > 0) return explicit;
  const raw = Number(process.env[envName]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}
