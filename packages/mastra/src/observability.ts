import type { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { Observability, SamplingStrategyType } from "@mastra/observability";
import { OtelExporter } from "@mastra/otel-exporter";

/**
 * If OTEL_EXPORTER_OTLP_ENDPOINT is set, ensure the agent is registered with
 * a Mastra instance that has OTEL observability configured.
 *
 * - If the agent already belongs to a Mastra with real observability, the OTEL
 *   instance is added alongside existing ones.
 * - If the agent belongs to a Mastra with NoOpObservability (default), or is a
 *   standalone agent with no Mastra at all, a new Mastra is created with our
 *   Observability and the agent is registered on it.
 */
export function setupObservability(agent: Agent): void {
  const exporterUrl = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!exporterUrl) return;

  // Mastra's OtelExporter passes the endpoint as the OTel SDK constructor
  // `url` option, which is used as-is (no signal path appended). We must
  // append `/v1/traces` ourselves so the SDK sends to the correct path.
  const tracesUrl = exporterUrl.replace(/\/+$/, "") + "/v1/traces";
  const serviceName = agent.name;

  const observability = new Observability({
    configs: {
      otel: {
        sampling: { type: SamplingStrategyType.ALWAYS },
        serviceName,
        exporters: [
          new OtelExporter({
            provider: {
              custom: {
                endpoint: tracesUrl,
                protocol: "http/protobuf",
              },
            },
          }),
        ],
      },
    },
  });

  const existingMastra = agent.getMastraInstance?.();

  // If the agent already has a Mastra with real observability (i.e. not NoOp),
  // register our instance alongside existing ones.
  if (existingMastra) {
    const hasRealObservability = existingMastra.observability.listInstances().size > 0;
    if (hasRealObservability) {
      const otelInstance = observability.getDefaultInstance();
      if (otelInstance) {
        existingMastra.observability.registerInstance("astropods-otel", otelInstance);
        console.log(`OTEL tracing enabled → ${tracesUrl}`);
      }
      return;
    }
  }

  // Either no Mastra instance or it has NoOpObservability.
  // Create a new Mastra with our observability and register the agent on it.
  // This calls agent.__registerMastra() internally, wiring the agent to the
  // new instance's observability.
  const mastra = new Mastra({ observability });
  mastra.addAgent(agent);

  console.log(`OTEL tracing enabled → ${tracesUrl}`);
}
