import { createTool } from "@mastra/core/tools";
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
 * The sandbox toolset, as Mastra tools, keyed by name so it drops straight
 * into an Agent's `tools`.
 *
 * Mastra hands `threadId` to every tool execution, and that id names the
 * sandbox. Nothing maps ids to sandboxes: the id *is* the name, so a thread
 * that resumes a week later reattaches to its own files.
 */
export function sandboxTools(options: SandboxToolsOptions = {}) {
  const { client, sandbox, prefix, ...clientOptions } = options;
  const sandboxes = client ?? new SandboxClient(clientOptions);

  const tools: Record<string, ReturnType<typeof createTool>> = {};
  for (const spec of SANDBOX_TOOLS as readonly ToolSpec[]) {
    tools[spec.name] = createTool({
      id: spec.name,
      description: spec.description,
      inputSchema: schemaFor(spec.args),
      execute: async (input, context) => {
        const threadId = (context as { threadId?: unknown } | undefined)?.threadId;
        const name = resolveSandboxName({
          threadId: typeof threadId === "string" ? threadId : undefined,
          sandbox,
          prefix,
        });
        return spec.run(sandboxes, name, (input ?? {}) as Record<string, unknown>);
      },
    });
  }
  return tools;
}
