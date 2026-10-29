import { createReadStream } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { agentFilesDir } from "../attach-file.js";
import type { AttachmentInput, ImageInput } from "../types.js";

export { attachFile } from "../attach-file.js";
export type { AttachFileInput } from "../attach-file.js";

/** Characters `readFilePage` returns per page. */
export const PAGE_CHARS = 20_000;
const SAMPLE_ROWS = 5;

/** Model-facing descriptions shared by every framework's `fileTools()`. */
export const FILE_TOOL_DESCRIPTIONS = {
  inspect_file:
    "Describe an attached file: its kind, size, and, for a table, the columns, the exact row count, and sample rows. Call this first for any attached file.",
  read_file: `Read one page (${PAGE_CHARS} characters) of an attached document's text: PDF, DOCX, or a text file. When nextOffset is not null, the document has more text.`,
  query_table:
    "Count, filter, and aggregate the rows of an attached CSV or XLSX file across the whole file. Use it for every count, total, or lookup; never estimate from sample rows.",
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
  sample: Cell[][];
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
}

export interface FilePage {
  text: string;
  offset: number;
  /** Offset of the next page, or null on the last page. */
  nextOffset: number | null;
  totalChars: number;
}

export type WhereOp = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "contains";
export type AggregateOp = "count" | "sum" | "min" | "max" | "avg";

export interface TableQuery {
  /** XLSX sheet name; defaults to the first sheet. */
  sheet?: string;
  /** Conditions that must all match. */
  where?: { column: string; op: WhereOp; value: string | number }[];
  aggregate?: { op: AggregateOp; column?: string };
  /** Matching rows to return; defaults to 20. */
  limit?: number;
}

export interface TableResult {
  columns: string[];
  /** Rows that matched, across the whole table. */
  matched: number;
  rows: Record<string, Cell>[];
  /** True when more rows matched than `rows` holds. */
  truncated: boolean;
  aggregate?: { op: AggregateOp; column?: string; result: number | undefined };
}

/** Names each attached file and its path for the model, leaving out files shown as `images`. */
export function attachmentNote(attachments: AttachmentInput[], images: ImageInput[] = []): string {
  const shown = new Set(images.map((i) => i.key).filter(Boolean));
  const files = attachments.filter((a) => a.path && !shown.has(a.key));
  if (files.length === 0) return "";
  const list = files.map((f) => `${f.name} (${f.path})`).join(", ");
  return `The user attached these files. Open them with a file-reading tool at the paths below. Do not guess their contents. ${list}`;
}

/** Rejects a path outside the agent's files dir. */
export function resolveAgentFile(path: string): string {
  const dir = resolve(agentFilesDir());
  const full = resolve(path);
  if (!full.startsWith(dir + sep)) {
    throw new Error(`Only files under ${dir} can be read`);
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
  yield* createReadStream(path).pipe(parse({ relax_column_count: true, skip_empty_lines: true }));
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
      sample: s.data.slice(1, 1 + SAMPLE_ROWS),
    }));
  } else if (kind === "pdf" || kind === "docx" || kind === "text") {
    const text = await documentText(full, kind);
    info.totalChars = text.length;
    info.pages = Math.ceil(text.length / PAGE_CHARS);
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
  const sample: Cell[][] = [];
  try {
    for await (const row of tableRows(path, "text")) {
      if (columns.length === 0) columns = row;
      else if (++rows <= SAMPLE_ROWS) sample.push(row);
    }
  } catch {
    return undefined;
  }
  return columns.length > 1 ? { columns, rows, sample } : undefined;
}

/** Returns one page of a document's text, starting at `offset`. */
export async function readFilePage(path: string, offset = 0): Promise<FilePage> {
  const full = resolveAgentFile(path);
  const text = await documentText(full, await sniff(full));
  const end = Math.min(offset + PAGE_CHARS, text.length);
  return { text: text.slice(offset, end), offset, nextOffset: end < text.length ? end : null, totalChars: text.length };
}

function comparable(v: Cell | string | number): string | number {
  if (typeof v === "number") return v;
  if (v === null || v === "") return "";
  const n = Number(v);
  return Number.isFinite(n) ? n : String(v);
}

function matches(record: Record<string, Cell>, where: NonNullable<TableQuery["where"]>): boolean {
  return where.every(({ column, op, value }) => {
    const a = comparable(record[column] ?? null);
    const b = comparable(value);
    switch (op) {
      case "eq": return a === b;
      case "ne": return a !== b;
      case "gt": return a > b;
      case "gte": return a >= b;
      case "lt": return a < b;
      case "lte": return a <= b;
      case "contains": return String(record[column] ?? "").toLowerCase().includes(String(value).toLowerCase());
    }
  });
}

/** Counts and totals cover the whole table; only the returned rows are limited. */
export async function queryTable(path: string, query: TableQuery = {}): Promise<TableResult> {
  const { sheet, where = [], aggregate, limit = 20 } = query;
  const full = resolveAgentFile(path);
  let header: string[] | undefined;
  let matched = 0;
  let acc: number | undefined;
  const rows: Record<string, Cell>[] = [];
  for await (const row of tableRows(full, await sniff(full), sheet)) {
    if (!header) {
      header = row.map((c) => String(c ?? ""));
      for (const name of [...where.map((w) => w.column), aggregate?.column]) {
        if (name && !header.includes(name)) throw new Error(`No column ${name}. Columns: ${header.join(", ")}`);
      }
      continue;
    }
    const record = Object.fromEntries(header.map((h, i) => [h, row[i] ?? null]));
    if (!matches(record, where)) continue;
    matched++;
    if (rows.length < limit) rows.push(record);
    const n = aggregate?.column ? Number(record[aggregate.column]) : NaN;
    if (Number.isFinite(n)) {
      if (aggregate?.op === "min") acc = acc === undefined ? n : Math.min(acc, n);
      else if (aggregate?.op === "max") acc = acc === undefined ? n : Math.max(acc, n);
      else acc = (acc ?? 0) + n;
    }
  }
  if (!header) throw new Error("The table is empty");
  let result = acc;
  if (aggregate?.op === "count") result = matched;
  else if (aggregate?.op === "avg") result = acc === undefined || matched === 0 ? undefined : acc / matched;
  return { columns: header, matched, rows, truncated: matched > rows.length, aggregate: aggregate && { ...aggregate, result } };
}
