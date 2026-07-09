import { describe, expect, test } from "bun:test";

import { createTraceparent } from "./trace";

describe("createTraceparent", () => {
  test("formats a valid W3C traceparent", () => {
    expect(
      createTraceparent({
        traceId: "4BF92F3577B34DA6A3CE929D0E0E4736",
        spanId: "00F067AA0BA902B7",
      }),
    ).toBe("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
  });

  test("uses explicit numeric trace flags", () => {
    expect(
      createTraceparent({
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
        traceFlags: 0,
      }),
    ).toBe("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00");
  });

  test("rejects invalid trace identifiers", () => {
    expect(
      createTraceparent({
        traceId: "00000000000000000000000000000000",
        spanId: "00f067aa0ba902b7",
      }),
    ).toBe("");
    expect(
      createTraceparent({
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "0000000000000000",
      }),
    ).toBe("");
  });
});
