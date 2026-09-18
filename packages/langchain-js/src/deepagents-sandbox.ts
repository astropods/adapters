import { BaseSandbox } from "deepagents";
import type { ExecuteResponse, FileDownloadResponse, FileUploadResponse } from "deepagents";
import {
  SandboxClient,
  SandboxRequestError,
  type SandboxOptions,
} from "@astropods/adapter-core";

export interface AstroSandboxOptions extends SandboxOptions {
  /**
   * Names the sandbox. Use the thread id: one thread is one sandbox, so a
   * conversation that resumes reattaches to its own files and two threads
   * never share a filesystem.
   */
  name: string;
  /** Reuse a client instead of constructing one. */
  client?: SandboxClient;
}

/**
 * An Astro sandbox as a Deep Agents backend.
 *
 * `BaseSandbox` asks for three things and builds the rest itself: `read`,
 * `write`, `edit`, `ls`, `glob` and `grep` are all composed from `execute`
 * using POSIX utilities. So this class is small on purpose, and the
 * filesystem tools an agent sees are Deep Agents' own rather than ours.
 */
export class AstroSandbox extends BaseSandbox {
  readonly id: string;

  private readonly client: SandboxClient;

  constructor(options: AstroSandboxOptions) {
    const { name, client, ...clientOptions } = options;
    super();
    this.id = name;
    this.client = client ?? new SandboxClient(clientOptions);
  }

  /**
   * One combined stream, because that is what the protocol returns and what
   * the base class parses. `exitCode` stays a number: the sandbox always runs
   * the command to an exit or reports a failure to start.
   */
  async execute(command: string): Promise<ExecuteResponse> {
    const result = await this.client.execCombined(this.id, command);
    return {
      output: result.output,
      exitCode: result.exitCode,
      truncated: result.truncated,
    };
  }

  async uploadFiles(files: Array<[string, Uint8Array]>): Promise<FileUploadResponse[]> {
    const responses: FileUploadResponse[] = [];
    for (const [path, content] of files) {
      try {
        await this.client.writeFileBytes(this.id, path, content);
        responses.push({ path, error: null });
      } catch (err) {
        responses.push({ path, error: fileError(err) });
      }
    }
    return responses;
  }

  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    const responses: FileDownloadResponse[] = [];
    for (const path of paths) {
      try {
        responses.push({ path, content: await this.client.readFileBytes(this.id, path), error: null });
      } catch (err) {
        responses.push({ path, content: null, error: fileError(err) });
      }
    }
    return responses;
  }
}

/**
 * The protocol wants a typed reason, and the only evidence is what the shell
 * printed. Anything unrecognized becomes `invalid_path` rather than a guess
 * at permissions, which would read as a security finding it is not.
 */
function fileError(err: unknown): FileDownloadResponse["error"] {
  const message = err instanceof SandboxRequestError ? err.message : String(err);
  if (/no such file|not found/i.test(message)) return "file_not_found";
  if (/permission denied/i.test(message)) return "permission_denied";
  if (/is a directory/i.test(message)) return "is_directory";
  return "invalid_path";
}
