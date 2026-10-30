import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachFile, runInTurn } from "./attach-file";
import type { OutgoingFile } from "./types";

describe("attachFile", () => {
  let dir: string;
  const previousDir = process.env.AGENT_FILES_DIR;
  const previousMax = process.env.FILES_MAX_MB;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "attach-file-"));
    process.env.AGENT_FILES_DIR = dir;
    delete process.env.FILES_MAX_MB;
  });

  afterEach(async () => {
    process.env.AGENT_FILES_DIR = previousDir;
    if (previousMax === undefined) delete process.env.FILES_MAX_MB;
    else process.env.FILES_MAX_MB = previousMax;
    await rm(dir, { recursive: true, force: true });
  });

  /** A sparse file, so a test can pass the 100 MiB default without writing 100 MiB. */
  async function fileOfSize(name: string, bytes: number): Promise<void> {
    await writeFile(join(dir, name), "");
    await truncate(join(dir, name), bytes);
  }

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

  test("rejects a name the messaging sidecar keeps for its own files", async () => {
    for (const name of ["slack-F1.blob", "summary.md.meta.json", "upload.tmp"]) {
      await expect(runInTurn(() => {}, () => attachFile({ name, data: "x" }))).rejects.toThrow(/cannot end in/);
    }
    expect(await readdir(dir)).toEqual([]);
  });

  test("keeps the bytes of a file already in the files dir", async () => {
    await writeFile(join(dir, "summary.md"), "first user's report");
    const files: OutgoingFile[] = [];
    await expect(
      runInTurn((f) => files.push(f), () => attachFile({ name: "summary.md", data: "second user's report" })),
    ).rejects.toThrow(/already exists/);

    expect(files).toEqual([]);
    expect(await readFile(join(dir, "summary.md"), "utf8")).toBe("first user's report");
  });

  test("rejects a file over FILES_MAX_MB before writing it", async () => {
    process.env.FILES_MAX_MB = "1";
    const files: OutgoingFile[] = [];
    await expect(
      runInTurn((f) => files.push(f), () => attachFile({ name: "big.csv", data: new Uint8Array(2 ** 20 + 1) })),
    ).rejects.toThrow(/big.csv is larger than the 1 MiB file size limit/);

    expect(files).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });

  test("limits an existing file to 100 MiB when FILES_MAX_MB is unset, and not at all when it is 0", async () => {
    await fileOfSize("export.csv", 100 * 2 ** 20 + 1);
    await expect(runInTurn(() => {}, () => attachFile({ name: "export.csv" }))).rejects.toThrow(/100 MiB/);

    process.env.FILES_MAX_MB = "0";
    const files: OutgoingFile[] = [];
    await runInTurn((f) => files.push(f), () => attachFile({ name: "export.csv" }));
    expect(files.map((f) => f.size)).toEqual([100 * 2 ** 20 + 1]);
  });

  test("rejects a missing file when no data is given", async () => {
    await expect(runInTurn(() => {}, () => attachFile({ name: "missing.pdf" }))).rejects.toThrow();
  });
});
