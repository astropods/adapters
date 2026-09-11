import type { Decision } from "./types.js";
import { AuthorizeUnavailableError } from "./types.js";

export interface AuthorizeRequest {
  identityType: string;
  identityId: string;
  adapter: string;
  identityScope: string;
}

/**
 * Calls astro-server's per-request authorization endpoint, presenting the
 * deploy token as a Bearer credential. The server validates the signature and
 * resolves the principal on every call.
 */
export class AuthorizeClient {
  private readonly serverUrl: string;

  constructor(
    serverUrl: string,
    private readonly token: string,
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.serverUrl = serverUrl.replace(/\/+$/, "");
  }

  async authorize(req: AuthorizeRequest): Promise<Decision> {
    const url = new URL(`${this.serverUrl}/api/v1/deployments/authorize`);
    if (req.identityType) url.searchParams.set("identity_type", req.identityType);
    if (req.identityId) url.searchParams.set("identity_id", req.identityId);
    if (req.identityScope) {
      url.searchParams.set("identity_scope", req.identityScope);
    }
    url.searchParams.set("adapter", req.adapter);

    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), {
        method: "GET",
        headers: { authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new AuthorizeUnavailableError(err);
    }

    if (!res.ok) {
      throw new AuthorizeUnavailableError(
        new Error(`authorize returned ${res.status}`),
      );
    }

    let body: { allowed?: boolean; user_id?: string };
    try {
      body = (await res.json()) as typeof body;
    } catch (err) {
      throw new AuthorizeUnavailableError(err);
    }

    return { allowed: body.allowed === true, userId: body.user_id || undefined };
  }
}
