import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileTools } from "./file-tools";

describe("fileTools", () => {
  let dir: string;
  const previousDir = process.env.AGENT_FILES_DIR;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "file-tools-"));
    process.env.AGENT_FILES_DIR = dir;
    await writeFile(join(dir, "deals.blob"), "account,amount\nAcme,120000\nGlobex,45000\n");
  });

  afterAll(async () => {
    process.env.AGENT_FILES_DIR = previousDir;
    await rm(dir, { recursive: true, force: true });
  });

  test("exposes the four file tools", () => {
    expect(Object.keys(fileTools())).toEqual(["inspect_file", "read_file", "read_table", "create_file"]);
  });

  test("read_table pages a staged file through the tool", async () => {
    const tools = fileTools();
    const path = join(dir, "deals.blob");
    const result = await (tools.read_table as any).execute({ path, limit: 1 }, {});
    expect(result).toEqual({ columns: ["account", "amount"], rows: [["Acme", "120000"]], offset: 0, nextOffset: 1 });
  });
});
