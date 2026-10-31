import { createReadStream } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { turnFiles } from "../attach-file.js";
import type { AttachmentInput, ImageInput } from "../types.js";

export { attachFile } from "../attach-file.js";
export type { AttachFileInput } from "../attach-file.js";

/** Characters `readFilePage` returns per page. */
export const PAGE_CHARS = 20_000;
/** Rows `readTable` returns per page unless `limit` says otherwise. */
export const PAGE_ROWS = 100;

/** Model-facing descriptions shared by every framework's `fileTools()`. */
export const FILE_TOOL_DESCRIPTIONS = {
  inspect_file:
    "Describe an attached file: its kind, size, and text length, or for a table each sheet's columns and row count.",
  read_file: `Read one page (${PAGE_CHARS} characters) of an attached document's text: PDF, DOCX, or a text file. When nextOffset is not null, the document has more text.`,
  read_table: `Read one page of rows (${PAGE_ROWS} by default) from an attached CSV or XLSX file. When nextOffset is not null, the table has more rows.`,
  create_file: "Create a text file, such as .md or .csv, and attach it to your reply.",
} as const;

/** What a file holds, sniffed from its bytes; staged uploads have no extension. */
export type FileKind = "pdf" | "docx" | "xlsx" | "zip" | "text" | "binary";
export type Cell = string | number | boolean | Date | null;

export interface TableInfo {
  /** Sheet name, for an XLSX file. */
  name?: string;
  columns: Cell[];
  /** Data rows, not counting the header. */
  rows: number;
}

export interface FileInfo {
  kind: FileKind;
  bytes: number;
  /** Text length, for a document or text file. */
  totalChars?: number;
  /** Pages `readFilePage` splits the text into. */
  pages?: number;
  /** One entry per sheet for XLSX, or one for a delimited text file. */
  tables?: TableInfo[];
  /** A PDF with no text layer, such as a scan; reading its text needs OCR. */
  scanned?: boolean;
}

export interface FilePage {
  text: string;
  offset: number;
  /** Offset of the next page, or null on the last page. */
  nextOffset: number | null;
  totalChars: number;
}

export interface TablePage {
  columns: Cell[];
  /** Cells as parsed: strings for a CSV, typed values for an XLSX sheet. */
  rows: Cell[][];
  offset: number;
  /** Offset of the next page, or null on the last page. */
  nextOffset: number | null;
}

/** Names each attached file and its path for the model, leaving out files shown as `images`. */
export function attachmentNote(attachments: AttachmentInput[], images: ImageInput[] = []): string {
  const shown = new Set(images.map((i) => i.key).filter(Boolean));
  const files = attachments.filter((a) => a.path && !shown.has(a.key));
  if (files.length === 0) return "";
  const list = files.map((f) => `${f.name} (${f.path})`).join(", ");
  return `The user attached these files. Open them with a file-reading tool at the paths below. Do not guess their contents. ${list}`;
}

/** Rejects any file the current turn did not receive or create. */
export function resolveAgentFile(path: string): string {
  const files = turnFiles();
  if (!files) throw new Error("Files can be read only while the agent handles a message");
  const full = resolve(path);
  // Every thread's and user's files share one dir, so a path inside it can still be another owner's file.
  if (!files.has(full)) {
    throw new Error(
      "Only the files attached to this message, and files created while answering it, can be read. Ask the user to attach the file again."
    );
  }
  return full;
}

async function sniff(path: string): Promise<FileKind> {
  const fh = await open(path, "r");
  try {
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(64 * 1024), 0, 64 * 1024, 0);
    const head = buffer.subarray(0, bytesRead);
    if (head.subarray(0, 4).toString("latin1") === "%PDF") return "pdf";
    if (head.subarray(0, 2).toString("latin1") === "PK") {
      const names = head.toString("latin1");
      if (names.includes("xl/")) return "xlsx";
      if (names.includes("word/")) return "docx";
      return "zip";
    }
    return head.includes(0) ? "binary" : "text";
  } finally {
    await fh.close();
  }
}

const NO_TEXT_LAYER = "This PDF has no text layer, so it is likely a scan. Reading it needs OCR, which this tool does not do.";

async function documentText(path: string, kind: FileKind): Promise<string> {
  switch (kind) {
    case "pdf": {
      const { extractText, getDocumentProxy } = await import("unpdf");
      const pdf = await getDocumentProxy(new Uint8Array(await readFile(path)));
      return (await extractText(pdf, { mergePages: true })).text;
    }
    case "docx": {
      const mammoth = await import("mammoth");
      return (await mammoth.extractRawText({ path })).value;
    }
    case "text":
      return readFile(path, "utf8");
    default:
      throw new Error(`A ${kind} file has no text to read`);
  }
}

async function xlsxSheets(path: string): Promise<{ sheet: string; data: Cell[][] }[]> {
  const { default: readXlsxFile } = await import("read-excel-file/node");
  return (await readXlsxFile(path)) as { sheet: string; data: Cell[][] }[];
}

/** Yields the header row first. */
async function* tableRows(path: string, kind: FileKind, sheet?: string): AsyncGenerator<Cell[]> {
  if (kind === "xlsx") {
    const sheets = await xlsxSheets(path);
    const chosen = sheet ? sheets.find((s) => s.sheet === sheet) : sheets[0];
    if (!chosen) throw new Error(`No sheet named ${sheet}. Sheets: ${sheets.map((s) => s.sheet).join(", ")}`);
    yield* chosen.data;
    return;
  }
  if (kind !== "text") throw new Error(`A ${kind} file is not a table`);
  const { parse } = await import("csv-parse");
  // Excel's "CSV UTF-8" export starts with a BOM, which would otherwise join the first column's name.
  yield* createReadStream(path).pipe(parse({ bom: true, relax_column_count: true, skip_empty_lines: true }));
}

/** For a table, the row count is exact: every row is read. */
export async function inspectFile(path: string): Promise<FileInfo> {
  const full = resolveAgentFile(path);
  const bytes = (await stat(full)).size;
  const kind = await sniff(full);
  const info: FileInfo = { kind, bytes };
  if (kind === "xlsx") {
    info.tables = (await xlsxSheets(full)).map((s) => ({
      name: s.sheet,
      columns: s.data[0] ?? [],
      rows: Math.max(s.data.length - 1, 0),
    }));
  } else if (kind === "pdf" || kind === "docx" || kind === "text") {
    const text = await documentText(full, kind);
    info.totalChars = text.length;
    info.pages = Math.ceil(text.length / PAGE_CHARS);
    if (kind === "pdf" && text.trim() === "") info.scanned = true;
    if (kind === "text") {
      const table = await delimitedTable(full);
      if (table) info.tables = [table];
    }
  }
  return info;
}

async function delimitedTable(path: string): Promise<TableInfo | undefined> {
  let columns: Cell[] = [];
  let rows = 0;
  try {
    for await (const row of tableRows(path, "text")) {
      if (columns.length === 0) columns = row;
      else rows++;
    }
  } catch {
    return undefined;
  }
  return columns.length > 1 ? { columns, rows } : undefined;
}

/** Returns one page of a document's text, starting at `offset`. */
export async function readFilePage(path: string, offset = 0): Promise<FilePage> {
  const full = resolveAgentFile(path);
  const kind = await sniff(full);
  const text = await documentText(full, kind);
  if (kind === "pdf" && text.trim() === "") throw new Error(NO_TEXT_LAYER);
  const end = Math.min(offset + PAGE_CHARS, text.length);
  return { text: text.slice(offset, end), offset, nextOffset: end < text.length ? end : null, totalChars: text.length };
}

/** Returns `limit` data rows of a CSV or XLSX table, starting at data row `offset`. */
export async function readTable(
  path: string,
  { sheet, offset = 0, limit = PAGE_ROWS }: { sheet?: string; offset?: number; limit?: number } = {}
): Promise<TablePage> {
  const full = resolveAgentFile(path);
  let columns: Cell[] | undefined;
  let index = 0;
  const rows: Cell[][] = [];
  for await (const row of tableRows(full, await sniff(full), sheet)) {
    if (!columns) {
      columns = row;
      continue;
    }
    if (index >= offset + limit) {
      return { columns, rows, offset, nextOffset: index };
    }
    if (index >= offset) rows.push(row);
    index++;
  }
  if (!columns) throw new Error("The table is empty");
  return { columns, rows, offset, nextOffset: null };
}
