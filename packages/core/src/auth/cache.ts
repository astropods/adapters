import type { Decision } from "./types.js";

export interface CacheKey {
  identityType: string;
  identityId: string;
  adapter: string;
  identityScope: string;
}

interface CacheEntry {
  decision: Decision;
  expiresAt: number;
}

/**
 * Caches allow and deny alike, so a denied principal stops re-hitting the
 * server. Eviction is lazy, on read.
 */
export class DecisionCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: CacheKey): Decision | undefined {
    const k = serialize(key);
    const entry = this.entries.get(k);
    if (!entry) return undefined;
    if (this.now() > entry.expiresAt) {
      this.entries.delete(k);
      return undefined;
    }
    return entry.decision;
  }

  set(key: CacheKey, decision: Decision, ttlMs = this.ttlMs): void {
    this.entries.set(serialize(key), {
      decision,
      expiresAt: this.now() + ttlMs,
    });
  }

  clear(): void {
    this.entries.clear();
  }
}

function serialize(key: CacheKey): string {
  return [key.identityType, key.identityId, key.adapter, key.identityScope].join(
    "\u0000",
  );
}
