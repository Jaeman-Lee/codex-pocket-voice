import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

const READ_CHUNK_BYTES = 64 * 1024;

export interface BoundedRegularFileOptions {
  maximumBytes: number;
  requirePrivate: boolean;
  requireSingleLink?: boolean;
}

export class BoundedRegularFileError extends Error {}

export async function readBoundedRegularFile(
  path: string,
  options: BoundedRegularFileOptions,
): Promise<Buffer> {
  if (!path || !Number.isSafeInteger(options.maximumBytes) || options.maximumBytes <= 0) {
    throw new BoundedRegularFileError("Bounded file options are invalid");
  }
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new BoundedRegularFileError("Bounded regular file could not be opened");
  }
  try {
    const initial = await handle.stat();
    const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
    if (!initial.isFile() || !Number.isSafeInteger(initial.size) || initial.size <= 0
        || initial.size > options.maximumBytes
        || (options.requireSingleLink !== false && initial.nlink !== 1)
        || (options.requirePrivate
          && ((initial.mode & 0o077) !== 0 || (currentUid !== null && initial.uid !== currentUid)))) {
      throw new BoundedRegularFileError("Bounded regular file metadata is invalid");
    }

    const bytes = await readWithLimit(handle, options.maximumBytes);
    const final = await handle.stat();
    if (bytes.length !== initial.size || final.size !== initial.size
        || final.mtimeMs !== initial.mtimeMs || final.ctimeMs !== initial.ctimeMs) {
      throw new BoundedRegularFileError("Bounded regular file changed while it was read");
    }
    return bytes;
  } catch (error) {
    if (error instanceof BoundedRegularFileError) throw error;
    throw new BoundedRegularFileError("Bounded regular file could not be read");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readWithLimit(handle: FileHandle, maximumBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const remaining = maximumBytes + 1 - total;
    if (remaining <= 0) throw new BoundedRegularFileError("Bounded regular file exceeds its size limit");
    const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maximumBytes) throw new BoundedRegularFileError("Bounded regular file exceeds its size limit");
    chunks.push(chunk.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
}
