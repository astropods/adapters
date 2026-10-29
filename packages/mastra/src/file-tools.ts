import { createTool } from "@mastra/core/tools";
import {
  FILE_TOOL_DESCRIPTIONS,
  attachFile,
  inspectFile,
  queryTable,
  readFilePage,
} from "@astropods/adapter-core/files";
import { z } from "zod";

/** File tools that never load a whole file into the prompt: `tools: { ...fileTools() }`. */
export function fileTools() {
  return {
    inspect_file: createTool({
      id: "inspect_file",
      description: FILE_TOOL_DESCRIPTIONS.inspect_file,
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => inspectFile(path),
    }),
    read_file: createTool({
      id: "read_file",
      description: FILE_TOOL_DESCRIPTIONS.read_file,
      inputSchema: z.object({ path: z.string(), offset: z.number().int().min(0).optional() }),
      execute: async ({ path, offset }) => readFilePage(path, offset),
    }),
    query_table: createTool({
      id: "query_table",
      description: FILE_TOOL_DESCRIPTIONS.query_table,
      inputSchema: tableQuerySchema,
      execute: async ({ path, ...query }) => queryTable(path, query),
    }),
    create_file: createTool({
      id: "create_file",
      description: FILE_TOOL_DESCRIPTIONS.create_file,
      inputSchema: z.object({
        name: z.string().describe("File name with extension, no directories"),
        content: z.string(),
        mimeType: z.string().optional(),
      }),
      execute: async ({ name, content, mimeType }) => {
        await attachFile({ name, data: content, mimeType });
        return { attached: name };
      },
    }),
  };
}

const tableQuerySchema = z.object({
  path: z.string(),
  sheet: z.string().optional().describe("XLSX sheet name; defaults to the first sheet"),
  where: z
    .array(
      z.object({
        column: z.string(),
        op: z.enum(["eq", "ne", "gt", "gte", "lt", "lte", "contains"]),
        value: z.union([z.string(), z.number()]),
      })
    )
    .optional()
    .describe("Conditions that must all match"),
  aggregate: z
    .object({ op: z.enum(["count", "sum", "min", "max", "avg"]), column: z.string().optional() })
    .optional(),
  limit: z.number().int().min(0).max(200).optional().describe("Matching rows to return; defaults to 20"),
});
