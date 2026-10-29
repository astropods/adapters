import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OutgoingFile } from "./types.js";

/** Default agent files mount, matching the K8s/compose deployer's AGENT_FILES_DIR. */
const DEFAULT_AGENT_FILES_DIR = "/data/files";

export function agentFilesDir(): string {
  return process.env.AGENT_FILES_DIR || DEFAULT_AGENT_FILES_DIR;
}

const turn = new AsyncLocalStorage<(file: OutgoingFile) => void>();

export function runInTurn<T>(onFile: (file: OutgoingFile) => void, fn: () => T): T {
  return turn.run(onFile, fn);
}

export interface AttachFileInput {
  /** Filename in the files dir, which is also its files-API key. One path segment. */
  name: string;
  /** Bytes to write. Omit to attach a file already in the files dir. */
  data?: string | Uint8Array;
  mimeType?: string;
}

/** Write a file to the agent's files dir and attach it to the current reply. Throws outside a turn. */
export async function attachFile(input: AttachFileInput): Promise<void> {
  const onFile = turn.getStore();
  if (!onFile) {
    throw new Error("attachFile must be called while the agent handles a message");
  }
  const { name, data, mimeType } = input;
  if (!name || name === "." || name === ".." || /[/\\]/.test(name)) {
    throw new Error(`attachFile: invalid file name ${JSON.stringify(name)}`);
  }
  const path = join(agentFilesDir(), name);
  let size: number;
  if (data === undefined) {
    size = (await stat(path)).size;
  } else {
    await mkdir(agentFilesDir(), { recursive: true });
    await writeFile(path, data);
    size = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
  }
  onFile({ name, mimeType, size });
}
