import { tool, type Tool } from "ai";
import {
  FILE_TOOL_DESCRIPTIONS,
  attachFile,
  inspectFile,
  readFilePage,
  readTable,
} from "@astropods/adapter-core/files";
import { z } from "zod";

/** File tools that never load a whole file into the prompt: `tools: { ...fileTools() }`. */
export function fileTools(): Record<"inspect_file" | "read_file" | "read_table" | "create_file", Tool> {
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
    read_table: tool({
      description: FILE_TOOL_DESCRIPTIONS.read_table,
      inputSchema: tablePageSchema,
      execute: ({ path, ...page }) => readTable(path, page),
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

const tablePageSchema = z.object({
  path: z.string(),
  sheet: z.string().optional().describe("XLSX sheet name; defaults to the first sheet"),
  offset: z.number().int().min(0).optional().describe("Data row to start at; 0 is the first row after the header"),
  limit: z.number().int().min(1).max(500).optional(),
});
