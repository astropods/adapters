import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PAGE_CHARS, inspectFile, queryTable, readFilePage, resolveAgentFile } from "./index";

const fixtures = join(import.meta.dir, "../../tests/fixtures/files");
let dir: string;
const previousDir = process.env.AGENT_FILES_DIR;
const at = (name: string) => join(dir, name);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-files-"));
  process.env.AGENT_FILES_DIR = dir;
  // Staged uploads carry no extension, so the copies drop theirs too.
  await copyFile(join(fixtures, "account-plan.pdf"), at("plan-pdf.blob"));
  await copyFile(join(fixtures, "account-plan.docx"), at("plan-docx.blob"));
  await copyFile(join(fixtures, "pipeline.xlsx"), at("pipeline.blob"));
  const rows = ["id,account,stage,amount"];
  for (let i = 1; i <= 5000; i++) rows.push(`${i},Account ${i % 97},Stage ${i % 7},${i * 10}`);
  await writeFile(at("deals.blob"), rows.join("\n") + "\n");
  await writeFile(at("long.blob"), "x".repeat(PAGE_CHARS + 10));
});

afterAll(async () => {
  process.env.AGENT_FILES_DIR = previousDir;
  await rm(dir, { recursive: true, force: true });
});

describe("inspectFile", () => {
  test("gives a CSV's columns, exact row count, and sample rows", async () => {
    const info = await inspectFile(at("deals.blob"));
    expect(info.kind).toBe("text");
    expect(info.tables?.[0]).toMatchObject({ columns: ["id", "account", "stage", "amount"], rows: 5000 });
    expect(info.tables?.[0]?.sample).toHaveLength(5);
  });

  test("lists every XLSX sheet", async () => {
    const info = await inspectFile(at("pipeline.blob"));
    expect(info.kind).toBe("xlsx");
    expect(info.tables?.map((t) => [t.name, t.rows])).toEqual([["Pipeline", 3], ["Contacts", 2]]);
  });

  test("sniffs a PDF and a DOCX without an extension", async () => {
    expect((await inspectFile(at("plan-pdf.blob"))).kind).toBe("pdf");
    expect((await inspectFile(at("plan-docx.blob"))).kind).toBe("docx");
  });
});

describe("readFilePage", () => {
  test("reads a PDF's text", async () => {
    const page = await readFilePage(at("plan-pdf.blob"));
    expect(page.text).toContain("Negotiation");
    expect(page.nextOffset).toBeNull();
  });

  test("reads a DOCX's text", async () => {
    expect((await readFilePage(at("plan-docx.blob"))).text).toContain("Globex");
  });

  test("pages through text longer than one page", async () => {
    const first = await readFilePage(at("long.blob"));
    expect(first.text).toHaveLength(PAGE_CHARS);
    expect(first.nextOffset).toBe(PAGE_CHARS);
    const second = await readFilePage(at("long.blob"), first.nextOffset!);
    expect(second).toMatchObject({ text: "x".repeat(10), nextOffset: null, totalChars: PAGE_CHARS + 10 });
  });
});

describe("queryTable", () => {
  test("counts and sums across the whole CSV while returning a few rows", async () => {
    const result = await queryTable(at("deals.blob"), {
      where: [{ column: "stage", op: "eq", value: "Stage 3" }],
      aggregate: { op: "sum", column: "amount" },
      limit: 2,
    });
    const ids = Array.from({ length: 5000 }, (_, i) => i + 1).filter((i) => i % 7 === 3);
    expect(result.matched).toBe(ids.length);
    expect(result.aggregate?.result).toBe(ids.reduce((s, i) => s + i * 10, 0));
    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  test("compares numbers numerically", async () => {
    // A string compare would also match "5000" and more; numeric gives exactly 5.
    const result = await queryTable(at("deals.blob"), { where: [{ column: "amount", op: "gt", value: 49_950 }], limit: 0 });
    expect(result.matched).toBe(5);
  });

  test("queries a named XLSX sheet", async () => {
    const result = await queryTable(at("pipeline.blob"), { sheet: "Contacts", where: [{ column: "Name", op: "contains", value: "dana" }] });
    expect(result.rows).toEqual([{ Account: "Acme Corp", Name: "Dana Lee", Role: "VP Engineering" }]);
  });

  test("averages and counts", async () => {
    const avg = await queryTable(at("pipeline.blob"), { aggregate: { op: "avg", column: "Amount" } });
    expect(avg.aggregate?.result).toBe((120000 + 45000 + 78000) / 3);
    const count = await queryTable(at("pipeline.blob"), { aggregate: { op: "count" } });
    expect(count.aggregate?.result).toBe(3);
  });

  test("names the columns when a query asks for one that is missing", async () => {
    await expect(queryTable(at("deals.blob"), { where: [{ column: "Amount", op: "gt", value: 1 }] })).rejects.toThrow(
      /No column Amount\. Columns: id, account, stage, amount/
    );
  });
});

describe("resolveAgentFile", () => {
  test("rejects a path outside the files dir", () => {
    expect(() => resolveAgentFile("/etc/passwd")).toThrow(/Only files under/);
    expect(() => resolveAgentFile(join(dir, "../escape"))).toThrow(/Only files under/);
  });
});
