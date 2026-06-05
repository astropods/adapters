import { describe, test, expect } from "bun:test";
import * as adapter from "./index";
import * as sdk from "@anthropic-ai/claude-agent-sdk";

describe("@astropods/adapter-claude-agent-sdk", () => {
  test("re-exports query (patched)", () => {
    expect(typeof adapter.query).toBe("function");
  });

  test("re-exports tool from the underlying SDK", () => {
    expect(typeof adapter.tool).toBe("function");
    expect(adapter.tool).toBe(sdk.tool);
  });

  test("re-exports createSdkMcpServer from the underlying SDK", () => {
    expect(typeof adapter.createSdkMcpServer).toBe("function");
    expect(adapter.createSdkMcpServer).toBe(sdk.createSdkMcpServer);
  });

  test("re-exports AbortError class from the underlying SDK", () => {
    expect(typeof adapter.AbortError).toBe("function");
    expect(adapter.AbortError).toBe(sdk.AbortError);
  });

  test("every named export from the SDK is present on the adapter", () => {
    const sdkExports = Object.keys(sdk);
    const adapterExports = new Set(Object.keys(adapter));
    const missing = sdkExports.filter((name) => !adapterExports.has(name));
    expect(missing).toEqual([]);
  });
});
