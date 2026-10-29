import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachFile, runInTurn } from "./attach-file";
import type { OutgoingFile } from "./types";

describe("attachFile", () => {
  let dir: string;
  const previousDir = process.env.AGENT_FILES_DIR;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "attach-file-"));
    process.env.AGENT_FILES_DIR = dir;
  });

  afterEach(async () => {
    process.env.AGENT_FILES_DIR = previousDir;
    await rm(dir, { recursive: true, force: true });
  });

  test("writes the bytes and attaches the file to the current turn", async () => {
    const files: OutgoingFile[] = [];
    await runInTurn((f) => files.push(f), async () => {
      await new Promise((r) => setTimeout(r, 1));
      await attachFile({ name: "plan.csv", data: "account,arr\n", mimeType: "text/csv" });
    });

    expect(files).toEqual([{ name: "plan.csv", mimeType: "text/csv", size: 12 }]);
    expect(await readFile(join(dir, "plan.csv"), "utf8")).toBe("account,arr\n");
  });

  test("attaches a file already in the files dir", async () => {
    await writeFile(join(dir, "report.pdf"), new Uint8Array([1, 2, 3]));
    const files: OutgoingFile[] = [];
    await runInTurn((f) => files.push(f), () => attachFile({ name: "report.pdf" }));

    expect(files).toEqual([{ name: "report.pdf", mimeType: undefined, size: 3 }]);
  });

  test("keeps concurrent turns apart", async () => {
    const a: OutgoingFile[] = [];
    const b: OutgoingFile[] = [];
    await Promise.all([
      runInTurn((f) => a.push(f), async () => {
        await new Promise((r) => setTimeout(r, 5));
        await attachFile({ name: "a.txt", data: "a" });
      }),
      runInTurn((f) => b.push(f), () => attachFile({ name: "b.txt", data: "b" })),
    ]);

    expect(a.map((f) => f.name)).toEqual(["a.txt"]);
    expect(b.map((f) => f.name)).toEqual(["b.txt"]);
  });

  test("throws outside a turn", async () => {
    await expect(attachFile({ name: "x.txt", data: "x" })).rejects.toThrow(/while the agent handles a message/);
  });

  test("rejects a name that is not one path segment", async () => {
    for (const name of ["", "..", "../x.txt", "sub/x.txt"]) {
      await expect(runInTurn(() => {}, () => attachFile({ name, data: "x" }))).rejects.toThrow(/invalid file name/);
    }
  });

  test("rejects a missing file when no data is given", async () => {
    await expect(runInTurn(() => {}, () => attachFile({ name: "missing.pdf" }))).rejects.toThrow();
  });
});
