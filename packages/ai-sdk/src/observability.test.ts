import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import { trace } from "@opentelemetry/api";
import { logger } from "@astropods/adapter-core";

import { _resetAstroTracerProviderForTests } from "../../core/dist/otel/provider.js";
import { setupObservability } from "./observability";

const ORIG_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
let infoSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  _resetAstroTracerProviderForTests();
  trace.disable();
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  infoSpy = spyOn(logger, "info").mockImplementation(() => logger);
});

afterEach(() => {
  _resetAstroTracerProviderForTests();
  trace.disable();
  infoSpy.mockRestore();
  if (ORIG_ENDPOINT === undefined) {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  } else {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = ORIG_ENDPOINT;
  }
});

function findEnabledLog(): string | undefined {
  for (const call of infoSpy.mock.calls) {
    const arg = call[0];
    if (typeof arg === "string" && arg.includes("OTEL tracing enabled")) {
      return arg;
    }
  }
  return undefined;
}

describe("setupObservability", () => {
  test("returns false and logs nothing when OTEL_EXPORTER_OTLP_ENDPOINT is unset", () => {
    expect(setupObservability()).toBe(false);
    expect(findEnabledLog()).toBeUndefined();
  });

  test("returns true and logs the traces URL when the endpoint is set", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";

    expect(setupObservability()).toBe(true);

    const log = findEnabledLog();
    expect(log).toBeDefined();
    expect(log!).toContain("/v1/traces");
  });

  test("strips trailing slashes before appending /v1/traces", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318///";

    expect(setupObservability()).toBe(true);

    const log = findEnabledLog();
    expect(log!).toContain("http://localhost:4318/v1/traces");
    expect(log!).not.toContain("////");
  });
});
