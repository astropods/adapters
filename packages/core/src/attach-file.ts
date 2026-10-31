import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { OutgoingFile } from "./types.js";

/** Default agent files mount, matching the K8s/compose deployer's AGENT_FILES_DIR. */
const DEFAULT_AGENT_FILES_DIR = "/data/files";
const DEFAULT_MAX_FILE_MB = 100;
/** The messaging sidecar stores its blobs, metadata, and temp files under these suffixes. */
const RESERVED_SUFFIXES = [".blob", ".meta.json", ".tmp"];

export function agentFilesDir(): string {
  return process.env.AGENT_FILES_DIR || DEFAULT_AGENT_FILES_DIR;
}

/** FILES_MAX_MB read as the messaging sidecar reads it; undefined is no limit. */
function maxFileBytes(): number | undefined {
  const raw = (process.env.FILES_MAX_MB ?? "").trim();
  const mb = /^\d+$/.test(raw) ? Number(raw) : DEFAULT_MAX_FILE_MB;
  return mb === 0 ? undefined : mb * 2 ** 20;
}

interface Turn {
  onFile: (file: OutgoingFile) => void;
  /** The only paths the read functions open: the turn's attachments and the files it created. */
  files: Set<string>;
}

const turn = new AsyncLocalStorage<Turn>();

export function runInTurn<T>(onFile: (file: OutgoingFile) => void, fn: () => T, attachments: string[] = []): T {
  return turn.run({ onFile, files: new Set(attachments.map((p) => resolve(p))) }, fn);
}

export function turnFiles(): ReadonlySet<string> | undefined {
  return turn.getStore()?.files;
}

export interface AttachFileInput {
  /** Filename in the files dir, which is also its files-API key. One path segment. */
  name: string;
  /** Bytes to write. Omit to attach a file already in the files dir. */
  data?: string | Uint8Array;
  mimeType?: string;
}

/**
 * Write a file to the agent's files dir and attach it to the current reply. Throws outside a turn,
 * when the file is over FILES_MAX_MB, or when `data` is given for a name already in the files dir.
 */
export async function attachFile(input: AttachFileInput): Promise<void> {
  const current = turn.getStore();
  if (!current) {
    throw new Error("attachFile must be called while the agent handles a message");
  }
  const { name, data, mimeType } = input;
  if (!name || name === "." || name === ".." || /[/\\]/.test(name)) {
    throw new Error(`attachFile: invalid file name ${JSON.stringify(name)}`);
  }
  if (RESERVED_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
    throw new Error(`attachFile: a file name cannot end in ${RESERVED_SUFFIXES.join(", ")}`);
  }
  const path = join(agentFilesDir(), name);
  const size =
    data === undefined
      ? (await stat(path)).size
      : typeof data === "string"
        ? Buffer.byteLength(data)
        : data.byteLength;
  const limit = maxFileBytes();
  if (limit !== undefined && size > limit) {
    throw new Error(`attachFile: ${name} is larger than the ${limit / 2 ** 20} MiB file size limit`);
  }
  if (data !== undefined) {
    await mkdir(agentFilesDir(), { recursive: true });
    try {
      // Every user's files share this dir, so overwriting would hand another user's file new bytes.
      await writeFile(path, data, { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      throw new Error(`attachFile: ${name} already exists in the files dir; use a new name`);
    }
  }
  current.onFile({ name, mimeType, size });
  current.files.add(resolve(path));
}
