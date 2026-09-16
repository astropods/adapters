import { BaseToolkit, tool } from "@langchain/core/tools";
import type { StructuredToolInterface, ToolRunnableConfig } from "@langchain/core/tools";
import {
  SANDBOX_TOOLS,
  SandboxClient,
  resolveSandboxName,
  type SandboxOptions,
  type ToolArg,
  type ToolSpec,
} from "@astropods/adapter-core";
import { z } from "zod";

export interface SandboxToolsOptions extends SandboxOptions {
  /** Reuse a client instead of constructing one. */
  client?: SandboxClient;
  /**
   * Pins every tool to one sandbox name. Leave unset and the thread id names
   * the sandbox, which is what keeps two conversations off one filesystem.
   */
  sandbox?: string;
  /** Prepended to the thread id, for telling environments apart. */
  prefix?: string;
}

function schemaFor(args: readonly ToolArg[]) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const arg of args) {
    const base = arg.type === "number" ? z.number() : z.string();
    shape[arg.name] = arg.required
      ? base.describe(arg.description)
      : base.optional().describe(arg.description);
  }
  return z.object(shape);
}

/**
 * The sandbox toolset, as LangChain tools.
 *
 * The thread id names the sandbox, read from `configurable.thread_id`, which
 * is what LangGraph already threads through a run. Nothing maps ids to
 * sandboxes: the id *is* the name.
 */
export function sandboxTools(options: SandboxToolsOptions = {}) {
  const { client, sandbox, prefix, ...clientOptions } = options;
  const sandboxes = client ?? new SandboxClient(clientOptions);

  return SANDBOX_TOOLS.map((spec: ToolSpec) =>
    tool(
      async (input: Record<string, unknown>, config?: ToolRunnableConfig) => {
        const threadId = config?.configurable?.thread_id as string | undefined;
        const name = resolveSandboxName({ threadId, sandbox, prefix });
        const result = await spec.run(sandboxes, name, input);
        return JSON.stringify(result);
      },
      {
        name: spec.name,
        description: spec.description,
        schema: schemaFor(spec.args),
      },
    ),
  );
}

/**
 * The same tools as a LangChain toolkit, which is how LangChain groups a
 * related set: it can be passed anywhere a toolkit is expected and answers
 * `getTools()`.
 */
export class AstroSandboxToolkit extends BaseToolkit {
  readonly tools: StructuredToolInterface[];

  constructor(options: SandboxToolsOptions = {}) {
    super();
    this.tools = sandboxTools(options) as unknown as StructuredToolInterface[];
  }
}
