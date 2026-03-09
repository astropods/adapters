/**
 * Thin, framework-agnostic guardrails client.
 *
 * Reads the ASTRO_GUARDRAILS env var (JSON array injected by the platform)
 * and provides helpers to call guardrail services via the standard HTTP contract.
 */

export interface GuardrailConfig {
  name: string;
  endpoint: string;
  scope: string[];
  on_fail: "block" | "warn" | "redact";
  config: Record<string, unknown>;
}

export interface GuardrailCheckRequest {
  content: string;
  scope: string;
  metadata?: Record<string, unknown>;
}

export interface GuardrailCheckResponse {
  passed: boolean;
  action: "pass" | "block" | "redact" | "warn";
  content: string;
  reason?: string;
  details?: Record<string, unknown>;
}

export interface GuardrailScopeResult {
  passed: boolean;
  content: string;
  failedGuardrail?: string;
  reason?: string;
}

export class GuardrailsClient {
  private guardrails: GuardrailConfig[];

  constructor(guardrails: GuardrailConfig[]) {
    this.guardrails = guardrails;
  }

  /** Call a specific guardrail by name. */
  async check(
    name: string,
    content: string,
    metadata?: Record<string, unknown>
  ): Promise<GuardrailCheckResponse> {
    const guardrail = this.guardrails.find((g) => g.name === name);
    if (!guardrail) {
      throw new Error(`Guardrail "${name}" not found in ASTRO_GUARDRAILS`);
    }

    const res = await fetch(`${guardrail.endpoint}/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content,
        scope: guardrail.scope[0],
        metadata,
        config: guardrail.config,
      }),
    });

    if (!res.ok) {
      throw new Error(
        `Guardrail "${name}" returned ${res.status}: ${await res.text()}`
      );
    }

    return res.json();
  }

  /** Run all guardrails matching a scope. Short-circuits on first block. */
  async checkScope(
    scope: string,
    content: string,
    metadata?: Record<string, unknown>
  ): Promise<GuardrailScopeResult> {
    const matching = this.guardrails.filter((g) => g.scope.includes(scope));
    if (matching.length === 0) {
      return { passed: true, content };
    }

    let current = content;

    for (const guardrail of matching) {
      const result = await this.check(guardrail.name, current, metadata);

      if (!result.passed) {
        if (guardrail.on_fail === "block") {
          return {
            passed: false,
            content: current,
            failedGuardrail: guardrail.name,
            reason: result.reason,
          };
        }
        if (guardrail.on_fail === "redact" && result.content) {
          current = result.content;
        }
        // on_fail === "warn": log and continue
        if (guardrail.on_fail === "warn") {
          console.warn(
            `[guardrails] "${guardrail.name}" flagged (warn): ${result.reason}`
          );
        }
      }
    }

    return { passed: true, content: current };
  }

  /** Returns true if any guardrails are configured. */
  get enabled(): boolean {
    return this.guardrails.length > 0;
  }

  /** Returns true if any guardrails match the given scope. */
  hasScope(scope: string): boolean {
    return this.guardrails.some((g) => g.scope.includes(scope));
  }
}

/**
 * Load guardrails from the ASTRO_GUARDRAILS env var.
 * Returns an empty client (no-op) if the env var is not set.
 */
export function loadGuardrails(): GuardrailsClient {
  const raw = process.env.ASTRO_GUARDRAILS;
  if (!raw) {
    return new GuardrailsClient([]);
  }

  try {
    const configs: GuardrailConfig[] = JSON.parse(raw);
    console.log(
      `[guardrails] Loaded ${configs.length} guardrail(s): ${configs.map((g) => g.name).join(", ")}`
    );
    return new GuardrailsClient(configs);
  } catch (e) {
    console.error("[guardrails] Failed to parse ASTRO_GUARDRAILS:", e);
    return new GuardrailsClient([]);
  }
}
