export interface ConnectionOptions {
  identityToken?: string;
  serverUrl?: string;
  timeoutSeconds?: number;
  fetchImpl?: typeof fetch;
}

export interface ConnectionToken {
  accessToken: string;
  expiresAt?: string;
  scopes: string[];
}

export type ConnectionErrorCode =
  | "not_consented"
  | "not_active"
  | "not_connected"
  | "needs_reauthorization"
  | "unavailable";

export class ConnectionError extends Error {
  constructor(
    readonly code: ConnectionErrorCode,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ConnectionError";
  }
}
