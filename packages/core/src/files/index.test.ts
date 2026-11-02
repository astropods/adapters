import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachFile, runInTurn } from "../attach-file";
import { PAGE_CHARS, PAGE_ROWS, createFile, inspectFile, readFilePage, readTable, resolveAgentFile } from "./index";

const fixtures = join(import.meta.dir, "../../tests/fixtures/files");
let dir: string;
const previousDir = process.env.AGENT_FILES_DIR;
const at = (name: string) => join(dir, name);
const staged = ["plan-pdf", "plan-docx", "pipeline", "scan", "deals", "long", "excel-utf8"].map((n) => `${n}.blob`);
const inTurn = <T>(fn: () => Promise<T>) => runInTurn(() => {}, fn, { attachments: staged.map(at) });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-files-"));
  process.env.AGENT_FILES_DIR = dir;
  // Staged uploads carry no extension, so the copies drop theirs too.
  await copyFile(join(fixtures, "account-plan.pdf"), at("plan-pdf.blob"));
  await copyFile(join(fixtures, "account-plan.docx"), at("plan-docx.blob"));
  await copyFile(join(fixtures, "pipeline.xlsx"), at("pipeline.blob"));
  // One page and no text, as a scan without OCR reads.
  await copyFile(join(fixtures, "scanned.pdf"), at("scan.blob"));
  const rows = ["id,account,stage,amount"];
  for (let i = 1; i <= 5000; i++) rows.push(`${i},Account ${i % 97},Stage ${i % 7},${i * 10}`);
  await writeFile(at("deals.blob"), rows.join("\n") + "\n");
  await writeFile(at("long.blob"), "x".repeat(PAGE_CHARS + 10));
  await writeFile(at("excel-utf8.blob"), "\uFEFFRegion,Amount\nWest,10\nEast,5\n");
});

afterAll(async () => {
  process.env.AGENT_FILES_DIR = previousDir;
  await rm(dir, { recursive: true, force: true });
});

describe("inspectFile", () => {
  test("gives a CSV's columns and exact row count", async () => {
    const info = await inTurn(() => inspectFile(at("deals.blob")));
    expect(info.kind).toBe("text");
    expect(info.tables).toEqual([{ columns: ["id", "account", "stage", "amount"], rows: 5000 }]);
  });

  test("reads the first column of a CSV that starts with a byte-order mark", async () => {
    expect((await inTurn(() => inspectFile(at("excel-utf8.blob")))).tables?.[0]?.columns).toEqual(["Region", "Amount"]);
  });

  test("lists every XLSX sheet", async () => {
    const info = await inTurn(() => inspectFile(at("pipeline.blob")));
    expect(info.kind).toBe("xlsx");
    expect(info.tables?.map((t) => [t.name, t.rows])).toEqual([["Pipeline", 3], ["Contacts", 2]]);
  });

  test("sniffs a PDF and a DOCX without an extension", async () => {
    expect((await inTurn(() => inspectFile(at("plan-pdf.blob")))).kind).toBe("pdf");
    expect((await inTurn(() => inspectFile(at("plan-docx.blob")))).kind).toBe("docx");
  });
});

describe("scanned PDF", () => {
  test("inspectFile flags it and readFilePage says it needs OCR", async () => {
    expect(await inTurn(() => inspectFile(at("scan.blob")))).toMatchObject({ kind: "pdf", totalChars: 0, scanned: true });
    await expect(inTurn(() => readFilePage(at("scan.blob")))).rejects.toThrow(/no text layer/);
  });

  test("a PDF with text is not flagged", async () => {
    expect((await inTurn(() => inspectFile(at("plan-pdf.blob")))).scanned).toBeUndefined();
  });
});

describe("readFilePage", () => {
  test("reads a PDF's text", async () => {
    const page = await inTurn(() => readFilePage(at("plan-pdf.blob")));
    expect(page.text).toContain("Negotiation");
    expect(page.nextOffset).toBeNull();
  });

  test("reads a DOCX's text", async () => {
    expect((await inTurn(() => readFilePage(at("plan-docx.blob")))).text).toContain("Globex");
  });

  test("pages through text longer than one page", async () => {
    const first = await inTurn(() => readFilePage(at("long.blob")));
    expect(first.text).toHaveLength(PAGE_CHARS);
    expect(first.nextOffset).toBe(PAGE_CHARS);
    const second = await inTurn(() => readFilePage(at("long.blob"), first.nextOffset!));
    expect(second).toMatchObject({ text: "x".repeat(10), nextOffset: null, totalChars: PAGE_CHARS + 10 });
  });
});

describe("readTable", () => {
  test("pages through every row of a CSV", async () => {
    const first = await inTurn(() => readTable(at("deals.blob")));
    expect(first.columns).toEqual(["id", "account", "stage", "amount"]);
    expect(first.rows).toHaveLength(PAGE_ROWS);
    expect(first.rows[0]).toEqual(["1", "Account 1", "Stage 1", "10"]);
    expect(first.nextOffset).toBe(PAGE_ROWS);

    const last = await inTurn(() => readTable(at("deals.blob"), { offset: 4998, limit: 10 }));
    expect(last).toMatchObject({ offset: 4998, nextOffset: null });
    expect(last.rows.map((r) => r[0])).toEqual(["4999", "5000"]);
  });

  test("a page that ends on the last row has no next page", async () => {
    expect((await inTurn(() => readTable(at("deals.blob"), { offset: 4990, limit: 10 }))).nextOffset).toBeNull();
  });

  test("reads a named XLSX sheet", async () => {
    const page = await inTurn(() => readTable(at("pipeline.blob"), { sheet: "Contacts" }));
    expect(page.columns).toEqual(["Account", "Name", "Role"]);
    expect(page.rows).toContainEqual(["Acme Corp", "Dana Lee", "VP Engineering"]);
    await expect(inTurn(() => readTable(at("pipeline.blob"), { sheet: "Missing" }))).rejects.toThrow(/Sheets: Pipeline, Contacts/);
  });
});

describe("resolveAgentFile", () => {
  test("rejects a file in the dir that the turn neither received nor created", async () => {
    await writeFile(at("summary.md"), "another thread's summary");
    await expect(inTurn(() => readFilePage(at("summary.md")))).rejects.toThrow(/attached to or created in this conversation/);
    await expect(inTurn(async () => resolveAgentFile("/etc/passwd"))).rejects.toThrow(/attached to or created in this conversation/);
  });

  test("opens a file the turn created", async () => {
    const page = await runInTurn(() => {}, async () => {
      await attachFile({ name: "notes.md", data: "created this turn" });
      return readFilePage(at("notes.md"));
    });
    expect(page.text).toBe("created this turn");
  });

  test("rejects a file the turn attached without writing it", async () => {
    await writeFile(at("report.md"), "another thread's report");
    const read = runInTurn(() => {}, async () => {
      await attachFile({ name: "report.md" });
      return readFilePage(at("report.md"));
    });
    await expect(read).rejects.toThrow(/attached to or created in this conversation/);
  });

  test("opens a file from an earlier turn of the same conversation, and no other conversation's", async () => {
    await runInTurn(() => {}, () => attachFile({ name: "draft.md", data: "first draft" }), {
      conversationId: "thread-a",
      attachments: [at("deals.blob")],
    });
    const later = (fn: () => Promise<unknown>) => runInTurn(() => {}, fn, { conversationId: "thread-a" });
    expect(((await later(() => readFilePage(at("draft.md")))) as { text: string }).text).toBe("first draft");
    await expect(later(() => readTable(at("deals.blob"), { limit: 1 }))).resolves.toBeDefined();

    const other = (fn: () => Promise<unknown>) => runInTurn(() => {}, fn, { conversationId: "thread-b" });
    await expect(other(() => readFilePage(at("draft.md")))).rejects.toThrow(/created in this conversation/);
    await expect(other(() => readTable(at("deals.blob")))).rejects.toThrow(/created in this conversation/);
  });

  test("createFile returns a path the conversation's next turn can read", async () => {
    await writeFile(at("brief.md"), "another thread's brief");
    const scope = { conversationId: "thread-c" };
    const created = await runInTurn(() => {}, () => createFile("brief.md", "# Brief"), scope);
    expect(created).toEqual({ attached: "brief-2.md", path: at("brief-2.md") });
    expect((await runInTurn(() => {}, () => readFilePage(created.path), scope)).text).toBe("# Brief");
  });

  test("refuses outside a turn", () => {
    expect(() => resolveAgentFile(at("deals.blob"))).toThrow(/while the agent handles a message/);
  });
});
