import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type { OutgoingFile } from "./types.js";

/** Default agent files mount, matching the K8s/compose deployer's AGENT_FILES_DIR. */
const DEFAULT_AGENT_FILES_DIR = "/data/files";
const DEFAULT_MAX_FILE_MB = 100;
/** The messaging sidecar stores its blobs, metadata, and temp files under these suffixes. */
const RESERVED_SUFFIXES = [".blob", ".meta.json", ".tmp"];
const MAX_NAME_TRIES = 1000;

export function agentFilesDir(): string {
  return process.env.AGENT_FILES_DIR || DEFAULT_AGENT_FILES_DIR;
}

/** FILES_MAX_MB read as the messaging sidecar reads it; undefined is no limit. */
function maxFileBytes(): number | undefined {
  const raw = (process.env.FILES_MAX_MB ?? "").trim();
  const mb = /^\d+$/.test(raw) ? Number(raw) : DEFAULT_MAX_FILE_MB;
  return mb === 0 ? undefined : mb * 2 ** 20;
}

const MAX_CONVERSATIONS = 1000;
const MAX_FILES_PER_CONVERSATION = 100;

interface Turn {
  onFile: (file: OutgoingFile) => void;
  /** The only paths the read functions open: the conversation's attachments and the files it created. */
  files: Set<string>;
}

const turn = new AsyncLocalStorage<Turn>();
/** In memory, so a restarted agent forgets earlier turns' files. Least recently used first. */
const conversations = new Map<string, Set<string>>();

function conversationFiles(conversationId: string | undefined): Set<string> {
  if (!conversationId) return new Set();
  const files = conversations.get(conversationId) ?? new Set<string>();
  conversations.delete(conversationId);
  conversations.set(conversationId, files);
  if (conversations.size > MAX_CONVERSATIONS) conversations.delete(conversations.keys().next().value!);
  return files;
}

function remember(files: Set<string>, path: string): void {
  const full = resolve(path);
  files.delete(full);
  files.add(full);
  if (files.size > MAX_FILES_PER_CONVERSATION) files.delete(files.values().next().value!);
}

export interface TurnScope {
  /** Files stay readable in the conversation's later turns. Omit to scope reads to this turn. */
  conversationId?: string;
  attachments?: string[];
}

export function runInTurn<T>(onFile: (file: OutgoingFile) => void, fn: () => T, scope: TurnScope = {}): T {
  const files = conversationFiles(scope.conversationId);
  for (const path of scope.attachments ?? []) remember(files, path);
  return turn.run({ onFile, files }, fn);
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

function numberedName(name: string, n: number): string {
  if (n === 1) return name;
  const ext = extname(name);
  return `${name.slice(0, name.length - ext.length)}-${n}${ext}`;
}

/**
 * Write a file to the agent's files dir and attach it to the current reply. Returns the file's name,
 * which gets a `-2`, `-3`, ... suffix when `data` is given for a name already in the files dir.
 * Throws outside a turn or when the file is over FILES_MAX_MB.
 */
export async function attachFile(input: AttachFileInput): Promise<string> {
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
  const size =
    data === undefined
      ? (await stat(join(agentFilesDir(), name))).size
      : typeof data === "string"
        ? Buffer.byteLength(data)
        : data.byteLength;
  const limit = maxFileBytes();
  if (limit !== undefined && size > limit) {
    throw new Error(`attachFile: ${name} is larger than the ${limit / 2 ** 20} MiB file size limit`);
  }
  const written = data === undefined ? name : await writeNew(name, data);
  current.onFile({ name: written, mimeType, size });
  // A file attached without data can be another thread's, so the read functions must not open it.
  if (data !== undefined) remember(current.files, join(agentFilesDir(), written));
  return written;
}

async function writeNew(name: string, data: string | Uint8Array): Promise<string> {
  await mkdir(agentFilesDir(), { recursive: true });
  for (let n = 1; n <= MAX_NAME_TRIES; n++) {
    const candidate = numberedName(name, n);
    try {
      // Every user's files share this dir, so overwriting would hand another user's file new bytes.
      await writeFile(join(agentFilesDir(), candidate), data, { flag: "wx" });
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new Error(`attachFile: ${name} and ${MAX_NAME_TRIES - 1} numbered copies already exist in the files dir`);
}
