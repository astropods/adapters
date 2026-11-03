import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { logger } from "./logger.js";
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

/** Conversations whose file lists stay in memory; the rest are read back from disk. */
const MAX_CONVERSATIONS = 1000;
const MAX_FILES_PER_CONVERSATION = 100;

interface Conversation {
  /** The only files the read functions open, each path mapped to the identity of the file it held when added. */
  files: Map<string, string>;
  /** Keeps the list across restarts. Unset for a turn with no conversation. */
  record?: string;
}

interface Turn {
  onFile: (file: OutgoingFile) => void;
  conversation: Conversation;
}

const turn = new AsyncLocalStorage<Turn>();
/** Least recently used first. */
const conversations = new Map<string, Conversation>();

// The device number can change when the volume is mounted again, so it is not part of the identity.
function identity(path: string): string | undefined {
  try {
    const { ino, mtimeNs } = statSync(path, { bigint: true });
    return `${ino}:${mtimeNs}`;
  } catch {
    return undefined;
  }
}

function recordPath(conversationId: string): string {
  // The files API lists only regular files, so the records' folder stays out of the files panel.
  const name = createHash("sha256").update(conversationId).digest("hex");
  return join(agentFilesDir(), ".conversations", `${name}.json`);
}

function load(record: string): Map<string, string> {
  try {
    return new Map(Object.entries(JSON.parse(readFileSync(record, "utf8"))));
  } catch {
    return new Map();
  }
}

function save({ files, record }: Conversation): void {
  if (!record) return;
  try {
    mkdirSync(dirname(record), { recursive: true });
    const tmp = `${record}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(files)));
    renameSync(tmp, record);
  } catch (err) {
    logger.warn({ err }, "Could not save the conversation's file list; it lasts until the agent restarts");
  }
}

function conversationFor(conversationId: string | undefined): Conversation {
  if (!conversationId) return { files: new Map() };
  let conversation = conversations.get(conversationId);
  if (!conversation) {
    const record = recordPath(conversationId);
    conversation = { files: load(record), record };
  }
  conversations.delete(conversationId);
  conversations.set(conversationId, conversation);
  if (conversations.size > MAX_CONVERSATIONS) conversations.delete(conversations.keys().next().value!);
  return conversation;
}

function remember({ files }: Conversation, path: string): void {
  const full = resolve(path);
  const id = identity(full);
  if (!id) return;
  files.delete(full);
  files.set(full, id);
  if (files.size > MAX_FILES_PER_CONVERSATION) files.delete(files.keys().next().value!);
}

export interface TurnScope {
  /** Files stay readable in the conversation's later turns. Omit to scope reads to this turn. */
  conversationId?: string;
  attachments?: string[];
}

export function runInTurn<T>(onFile: (file: OutgoingFile) => void, fn: () => T, scope: TurnScope = {}): T {
  const conversation = conversationFor(scope.conversationId);
  const attachments = scope.attachments ?? [];
  for (const path of attachments) remember(conversation, path);
  if (attachments.length > 0) save(conversation);
  return turn.run({ onFile, conversation }, fn);
}

/** Undefined outside a turn. A file deleted and replaced at the same path is not the one the conversation received. */
export function canReadInTurn(path: string): boolean | undefined {
  const current = turn.getStore();
  if (!current) return undefined;
  const full = resolve(path);
  const id = current.conversation.files.get(full);
  return id !== undefined && id === identity(full);
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
  if (data !== undefined) {
    remember(current.conversation, join(agentFilesDir(), written));
    save(current.conversation);
  }
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
