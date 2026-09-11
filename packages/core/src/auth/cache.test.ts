import { describe, expect, test } from "bun:test";

import { DecisionCache, type CacheKey } from "./cache";

const key = (over: Partial<CacheKey> = {}): CacheKey => ({
  identityType: "user",
  identityId: "user_1",
  adapter: "custom",
  identityScope: "",
  ...over,
});

describe("DecisionCache", () => {
  test("returns a stored decision within its TTL", () => {
    let now = 1000;
    const cache = new DecisionCache(60_000, () => now);
    cache.set(key(), { allowed: true, userId: "user_1" });

    now += 59_000;
    expect(cache.get(key())).toEqual({ allowed: true, userId: "user_1" });
  });

  test("caches denials, so a denied caller stops hitting the server", () => {
    const cache = new DecisionCache(60_000, () => 0);
    cache.set(key(), { allowed: false });
    expect(cache.get(key())).toEqual({ allowed: false });
  });

  test("drops an entry once its TTL passes", () => {
    let now = 0;
    const cache = new DecisionCache(60_000, () => now);
    cache.set(key(), { allowed: true });

    now = 60_001;
    expect(cache.get(key())).toBeUndefined();
  });

  test("honors a per-entry TTL shorter than the default", () => {
    let now = 0;
    const cache = new DecisionCache(60_000, () => now);
    cache.set(key(), { allowed: true }, 10_000);

    now = 10_001;
    expect(cache.get(key())).toBeUndefined();
  });

  test("separates entries that differ in any one key field", () => {
    const cache = new DecisionCache(60_000, () => 0);
    cache.set(key(), { allowed: true });

    expect(cache.get(key({ identityId: "user_2" }))).toBeUndefined();
    expect(cache.get(key({ adapter: "web" }))).toBeUndefined();
    expect(cache.get(key({ identityScope: "T123" }))).toBeUndefined();
    expect(cache.get(key({ identityType: "slack" }))).toBeUndefined();
  });

  test("does not collide when a separator-like value appears inside a field", () => {
    const cache = new DecisionCache(60_000, () => 0);
    cache.set(key({ identityId: "a", adapter: "b custom" }), { allowed: true });
    expect(cache.get(key({ identityId: "a b", adapter: "custom" }))).toBeUndefined();
  });
});
