import type { Authorizer } from "./authorizer.js";
import { AuthorizeUnavailableError, type HeaderLike, type Principal } from "./types.js";

export type GuardOutcome =
  | { status: 200; principal: Principal | null }
  | { status: 401 | 403 | 503; principal: null; message: string };

/**
 * The identify-then-authorize sequence every binding runs, with the outcome
 * already mapped onto the status code that binding returns.
 *
 * An absent identity is authorized as anonymous, not refused here: the server's
 * `anyone` short-circuit is what admits a public interface.
 */
export async function guard(
  authz: Authorizer,
  headers: HeaderLike,
): Promise<GuardOutcome> {
  const principal = await authz.identify(headers);

  try {
    const decision = await authz.authorize(principal);
    if (!decision.allowed) {
      return principal
        ? { status: 403, principal: null, message: "Forbidden" }
        : { status: 401, principal: null, message: "Unauthorized" };
    }
    return { status: 200, principal };
  } catch (err) {
    if (err instanceof AuthorizeUnavailableError) {
      return {
        status: 503,
        principal: null,
        message: "Authorization unavailable",
      };
    }
    throw err;
  }
}
