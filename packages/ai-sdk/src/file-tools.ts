import { tool, type Tool } from "ai";
import {
  FILE_TOOL_DESCRIPTIONS,
  attachFile,
  inspectFile,
  queryTable,
  readFilePage,
} from "@astropods/adapter-core/files";
import { z } from "zod";

/** File tools that never load a whole file into the prompt: `tools: { ...fileTools() }`. */
export function fileTools(): Record<"inspect_file" | "read_file" | "query_table" | "create_file", Tool> {
  return {
    inspect_file: tool({
      description: FILE_TOOL_DESCRIPTIONS.inspect_file,
      inputSchema: z.object({ path: z.string() }),
      execute: ({ path }) => inspectFile(path),
    }),
    read_file: tool({
      description: FILE_TOOL_DESCRIPTIONS.read_file,
      inputSchema: z.object({ path: z.string(), offset: z.number().int().min(0).optional() }),
      execute: ({ path, offset }) => readFilePage(path, offset),
    }),
    query_table: tool({
      description: FILE_TOOL_DESCRIPTIONS.query_table,
      inputSchema: tableQuerySchema,
      execute: ({ path, ...query }) => queryTable(path, query),
    }),
    create_file: tool({
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
