export {
  Authorizer,
  DEFAULT_ADAPTER,
  DEFAULT_CACHE_TTL_SECONDS,
  DEFAULT_TIMEOUT_SECONDS,
  DEGRADED_CACHE_TTL_SECONDS,
} from "./authorizer.js";

export { guard } from "./guard.js";
export type { GuardOutcome } from "./guard.js";

export {
  expressMiddleware,
  fastifyHook,
  honoMiddleware,
  withAuth,
} from "./bindings.js";

export {
  AlbIdentityVerifier,
  regionFromSignerArn,
  ACCESS_TOKEN_HEADER,
  DATA_HEADER,
  IDENTITY_HEADER,
} from "./alb.js";
export type { AlbIdentityVerifierOptions } from "./alb.js";

export { AuthorizeClient } from "./client.js";
export type { AuthorizeRequest } from "./client.js";

export { DecisionCache } from "./cache.js";
export type { CacheKey } from "./cache.js";

export { decodeDeployToken } from "./token.js";
export type { DeployTokenClaims } from "./token.js";

export {
  AuthorizeUnavailableError,
  IdentityTokenError,
  normalizeHeaders,
} from "./types.js";
export type {
  AuthorizerOptions,
  Decision,
  HeaderLike,
  Principal,
} from "./types.js";
