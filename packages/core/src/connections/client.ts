import { decodeDeployToken } from "../auth/token.js";
import { ConnectionError, type ConnectionErrorCode, type ConnectionOptions, type ConnectionToken } from "./types.js";

const DEFAULT_TIMEOUT_SECONDS = 15;
const REFRESH_MARGIN_MS = 60_000;

const KNOWN_CODES = new Set<ConnectionErrorCode>(["not_consented", "not_active", "not_connected", "needs_reauthorization"]);

export class ConnectionClient {
  private readonly serverUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly cache = new Map<string, ConnectionToken>();

  constructor(options: ConnectionOptions = {}) {
    this.token = options.identityToken ?? process.env.ASTRO_AUTHZ_TOKEN ?? "";
    const claims = decodeDeployToken(this.token);
    this.serverUrl = (options.serverUrl ?? claims.issuer).replace(/\/+$/, "");
    this.timeoutMs = (options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getToken(userId: string, provider: string): Promise<ConnectionToken> {
    if (!userId) throw new ConnectionError("not_consented", 0, "no user for this turn");
    const key = `${userId}\u0000${provider}`;
    const cached = this.cache.get(key);
    if (cached && isFresh(cached)) return cached;
    this.cache.delete(key);

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.serverUrl}/api/v1/deployments/connections/token`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: JSON.stringify({ user_id: userId, provider }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new ConnectionError("unavailable", 0, `connection token request failed: ${String(err)}`);
    }

    if (!res.ok) {
      const code = await errorCode(res);
      throw new ConnectionError(
        code && KNOWN_CODES.has(code as ConnectionErrorCode) ? (code as ConnectionErrorCode) : "unavailable",
        res.status,
        `${provider} connection token refused: ${code ?? res.statusText}`,
      );
    }

    const body = (await res.json()) as { access_token?: string; expires_at?: string; scopes?: string[] };
    const token: ConnectionToken = {
      accessToken: body.access_token ?? "",
      expiresAt: body.expires_at || undefined,
      scopes: body.scopes ?? [],
    };
    this.cache.set(key, token);
    return token;
  }
}

function isFresh(token: ConnectionToken): boolean {
  if (!token.expiresAt) return false;
  return Date.parse(token.expiresAt) - REFRESH_MARGIN_MS > Date.now();
}

async function errorCode(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : undefined;
  } catch {
    return undefined;
  }
}
