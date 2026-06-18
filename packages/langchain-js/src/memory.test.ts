import { describe, test, expect } from "bun:test";
import { MemorySaver } from "@langchain/langgraph-checkpoint";

import { ensureCheckpointer } from "./memory";

describe("ensureCheckpointer", () => {
  test("installs a MemorySaver when the agent has none", () => {
    const agent: { checkpointer?: unknown } = { checkpointer: undefined };
    expect(ensureCheckpointer(agent)).toBe(true);
    expect(agent.checkpointer).toBeInstanceOf(MemorySaver);
  });

  test("leaves a checkpointer the caller configured untouched", () => {
    const existing = new MemorySaver();
    const agent = { checkpointer: existing };
    expect(ensureCheckpointer(agent)).toBe(false);
    expect(agent.checkpointer).toBe(existing);
  });

  test("works through a ReactAgent-style getter/setter", () => {
    let backing: unknown;
    const agent = {
      get checkpointer() {
        return backing;
      },
      set checkpointer(value: unknown) {
        backing = value;
      },
    };
    expect(ensureCheckpointer(agent)).toBe(true);
    expect(backing).toBeInstanceOf(MemorySaver);
  });

  test("no-ops for agents without a checkpointer property", () => {
    const agent = { stream() {} };
    expect(ensureCheckpointer(agent)).toBe(false);
    expect("checkpointer" in agent).toBe(false);
  });

  test("respects a checkpointer enabled via boolean", () => {
    // createAgent accepts `checkpointer: true` to opt into default persistence.
    const agent = { checkpointer: true };
    expect(ensureCheckpointer(agent)).toBe(false);
    expect(agent.checkpointer).toBe(true);
  });

  test("returns false for non-object input", () => {
    expect(ensureCheckpointer(null)).toBe(false);
    expect(ensureCheckpointer(undefined)).toBe(false);
  });
});
