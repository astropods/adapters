import { describe, test, expect } from "bun:test";
import { runScenario } from "./fixtures/child-runner";

describe("tier 1 — plumbing", () => {
  test("with no OTLP endpoint: no provider registered, query not patched", async () => {
    const { exitCode, result, stderr } = await runScenario("tier-1-probe.ts", {
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: "" },
    });

    expect(exitCode, `stderr:\n${stderr}`).toBe(0);
    expect(result).toMatchObject({
      hadEndpoint: false,
      queryPatched: false,
      spanRecording: false,
    });
  });

  test("with OTLP endpoint set: provider registered, query patched, spans recording", async () => {
    const { exitCode, result, stderr } = await runScenario("tier-1-probe.ts", {
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:65535",
        ASTRO_AGENT_NAME: "tier-1-agent",
      },
    });

    expect(exitCode, `stderr:\n${stderr}`).toBe(0);
    expect(result).toMatchObject({
      hadEndpoint: true,
      queryPatched: true,
      spanRecording: true,
    });
  });
});
