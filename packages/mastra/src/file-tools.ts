import { createTool } from "@mastra/core/tools";
import {
  FILE_TOOL_DESCRIPTIONS,
  attachFile,
  inspectFile,
  readFilePage,
  readTable,
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
    read_table: createTool({
      id: "read_table",
      description: FILE_TOOL_DESCRIPTIONS.read_table,
      inputSchema: tablePageSchema,
      execute: async ({ path, ...page }) => readTable(path, page),
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

const tablePageSchema = z.object({
  path: z.string(),
  sheet: z.string().optional().describe("XLSX sheet name; defaults to the first sheet"),
  offset: z.number().int().min(0).optional().describe("Data row to start at; 0 is the first row after the header"),
  limit: z.number().int().min(1).max(500).optional(),
});
