import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, unlink } from "node:fs/promises";
import { basename, sep } from "node:path";
import { tmpdir } from "node:os";
import { Transform, type Readable } from "node:stream";
import type { AttachmentMetadata, AttachmentStreamOptions } from "./types.js";

const rfc5987 = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
type FileIdentity = { dev: number; ino: number };

const hasIdentity = (info: { dev: number; ino: number }, identity: FileIdentity): boolean => info.dev === identity.dev && info.ino === identity.ino;
async function attachmentDirectory(tempDirectory: string): Promise<string> {
  if (typeof tempDirectory !== "string" || tempDirectory.length === 0) throw new TypeError("Attachment temporary directory is required");
  const supplied = await lstat(tempDirectory);
  if (!supplied.isDirectory() || supplied.isSymbolicLink()) throw new Error("Attachment temporary directory must be a non-symlink directory");
  const directory = await realpath(tempDirectory);
  if (directory === await realpath(tmpdir())) throw new Error("Attachment temporary directory must be a dedicated directory, not the process-wide temporary directory");
  const resolved = await lstat(directory);
  if (!hasIdentity(resolved, supplied)) throw new Error("Attachment temporary directory changed while being validated");
  if ((supplied.mode & 0o022) !== 0) throw new Error("Attachment temporary directory must not be group- or other-writable");
  return directory;
}
/** Node has no unlink-at-file-descriptor API; compare identity immediately before unlinking. */
async function unlinkIfOwned(path: string, identity: FileIdentity): Promise<boolean> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || !hasIdentity(info, identity)) return false;
  await unlink(path);
  return true;
}

/** Header value safe for both legacy clients and RFC 5987-aware clients. */
export function contentDisposition(filename: string): string {
  const name = basename(filename).replace(/[\r\n"\\]/g, "_") || "attachment";
  const ascii = name.replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${rfc5987(name)}`;
}

class ByteLimit extends Transform {
  #seen = 0;
  constructor(private readonly maximum: number) { super(); }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error) => void): void {
    this.#seen += chunk.length;
    if (this.#seen > this.maximum) { done(new Error(`Attachment exceeds ${String(this.maximum)} byte limit`)); return; }
    this.push(chunk);
    done();
  }
}

/** A one-shot, bounded stream. Its Hypermail temporary source is deleted on completion, failure, or cancellation. */
export class AttachmentStream {
  readonly metadata: AttachmentMetadata;
  readonly contentDisposition: string;
  readonly stream: Readable;
  #cleanupPromise: Promise<void> | undefined;
  #path: string;
  #identity: FileIdentity;

  private constructor(metadata: AttachmentMetadata, path: string, options: AttachmentStreamOptions, handle: Awaited<ReturnType<typeof open>>, identity: FileIdentity) {
    this.metadata = metadata;
    this.#path = path;
    this.#identity = identity;
    this.contentDisposition = contentDisposition(metadata.name);
    const source = handle.createReadStream({ autoClose: true, highWaterMark: 64 * 1024 });
    const limited = source.pipe(new ByteLimit(options.maxBytes));
    this.stream = limited;
    // A transform error must also stop the source; pipe preserves backpressure but does not do this for us.
    limited.once("error", () => source.destroy());
    const cancel = () => limited.destroy(options.signal?.reason instanceof Error ? options.signal.reason : new Error("Attachment stream cancelled"));
    options.signal?.addEventListener("abort", cancel, { once: true });
    limited.once("close", () => { options.signal?.removeEventListener("abort", cancel); void this.cleanup(); });
  }

  static async open(metadata: AttachmentMetadata, path: string, options: AttachmentStreamOptions): Promise<AttachmentStream> {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) throw new RangeError("maxBytes must be a positive integer");
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("Attachment stream cancelled");
    const directory = await attachmentDirectory(options.tempDirectory);
    const actualPath = await realpath(path);
    if (!actualPath.startsWith(directory.endsWith(sep) ? directory : `${directory}${sep}`)) throw new Error("Attachment path is outside the configured temporary directory");
    const handle = await open(actualPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let closed = false;
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("Attachment path is not a file");
      const identity = { dev: info.dev, ino: info.ino };
      if (metadata.size !== undefined && metadata.size > options.maxBytes) {
        await handle.close(); closed = true;
        await unlinkIfOwned(actualPath, identity).catch(() => undefined);
        throw new Error(`Attachment exceeds ${String(options.maxBytes)} byte limit`);
      }
      return new AttachmentStream(metadata, actualPath, options, handle, identity);
    } catch (error) { if (!closed) await handle.close().catch(() => undefined); throw error; }
  }

  async cancel(reason?: Error): Promise<void> { this.stream.destroy(reason ?? new Error("Attachment stream cancelled")); await this.cleanup(); }
  cleanup(): Promise<void> {
    this.#cleanupPromise ??= unlinkIfOwned(this.#path, this.#identity).then(() => undefined).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    return this.#cleanupPromise;
  }
}

export interface AttachmentOrphanCleanupOptions { tempDirectory: string; minimumAgeMs: number; prefix?: string; maxFiles?: number; now?: () => Date }
/** Removes a bounded number of old, regular Hypermail-owned files from a private dedicated directory. */
export async function cleanupAttachmentOrphans(options: AttachmentOrphanCleanupOptions): Promise<number> {
  if (!Number.isSafeInteger(options.minimumAgeMs) || options.minimumAgeMs < 0) throw new RangeError("minimumAgeMs must be a non-negative integer");
  const maxFiles = options.maxFiles ?? 100;
  if (!Number.isSafeInteger(maxFiles) || maxFiles <= 0) throw new RangeError("maxFiles must be a positive integer");
  const prefix = options.prefix ?? "hypermail-attachment-";
  if (!/^hypermail-attachment-[A-Za-z0-9_-]*$/.test(prefix)) throw new RangeError("Attachment orphan prefix must be Hypermail-owned");
  if (typeof options.tempDirectory !== "string" || options.tempDirectory.length === 0) throw new TypeError("Attachment temporary directory is required");
  await mkdir(options.tempDirectory, { recursive: true, mode: 0o700 });
  const directory = await attachmentDirectory(options.tempDirectory);
  const cutoff = (options.now?.() ?? new Date()).valueOf() - options.minimumAgeMs;
  let removed = 0;
  const entries = await opendir(directory);
  try {
    for await (const entry of entries) {
      if (removed === maxFiles) break;
      if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
      const path = `${directory}${sep}${entry.name}`;
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.mtimeMs > cutoff) continue;
      if (await unlinkIfOwned(path, { dev: info.dev, ino: info.ino })) removed++;
    }
  } finally { await entries.close().catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "ERR_DIR_CLOSED") throw error; }); }
  return removed;
}
