import { describe, test, expect } from "bun:test";
import { MemorySaver } from "@langchain/langgraph-checkpoint";

import { ensureCheckpointer } from "./memory";

describe("ensureCheckpointer", () => {
  test("installs a MemorySaver when the agent has none", async () => {
    const agent: { checkpointer?: unknown } = { checkpointer: undefined };
    expect(await ensureCheckpointer(agent)).toBe(true);
    expect(agent.checkpointer).toBeInstanceOf(MemorySaver);
  });

  test("leaves a checkpointer the caller configured untouched", async () => {
    const existing = new MemorySaver();
    const agent = { checkpointer: existing };
    expect(await ensureCheckpointer(agent)).toBe(false);
    expect(agent.checkpointer).toBe(existing);
  });

  test("respects an explicit checkpointer: false opt-out", async () => {
    // createAgent accepts `checkpointer: false` to disable persistence; only a
    // nullish value counts as unset, so this must be left as-is.
    const agent = { checkpointer: false };
    expect(await ensureCheckpointer(agent)).toBe(false);
    expect(agent.checkpointer).toBe(false);
  });

  test("respects a checkpointer enabled via boolean", async () => {
    const agent = { checkpointer: true };
    expect(await ensureCheckpointer(agent)).toBe(false);
    expect(agent.checkpointer).toBe(true);
  });

  test("works through a ReactAgent-style getter/setter", async () => {
    let backing: unknown;
    const agent = {
      get checkpointer() {
        return backing;
      },
      set checkpointer(value: unknown) {
        backing = value;
      },
    };
    expect(await ensureCheckpointer(agent)).toBe(true);
    expect(backing).toBeInstanceOf(MemorySaver);
  });

  test("no-ops for agents without a checkpointer property", async () => {
    const agent = { stream() {} };
    expect(await ensureCheckpointer(agent)).toBe(false);
    expect("checkpointer" in agent).toBe(false);
  });

  test("returns false for non-object input", async () => {
    expect(await ensureCheckpointer(null)).toBe(false);
    expect(await ensureCheckpointer(undefined)).toBe(false);
  });
});
