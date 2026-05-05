/**
 * Main-process side of header parsing: reads only the first N bytes of a model
 * file, then delegates to the pure parsers in the renderer module.
 */

import fs from 'fs';
import path from 'path';
import {
  detectFormat,
  parseHeader,
  suggestedReadBytes,
} from '../../renderer/modelhub/parsers';
import { HeaderMeta } from '../../renderer/modelhub/types';
import {
  detectShardInfo,
  isCanonicalShard,
} from '../../renderer/modelhub/shard';
import { sumShardBytes } from './shardFs';

export interface ParseHeaderResult {
  ok: boolean;
  meta?: HeaderMeta;
  error?: string;
}

export async function readModelHeader(
  filePath: string,
): Promise<ParseHeaderResult> {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return { ok: false, error: 'invalid file path' };
  }

  const fileName = path.basename(filePath);
  const format = detectFormat(fileName);
  if (format === 'unknown') {
    return {
      ok: true,
      meta: {
        format: 'unknown',
        architecture: 'unknown',
        warnings: ['unsupported file extension'],
      },
    };
  }

  const wantedBytes = suggestedReadBytes(format);

  let fd: number | undefined;
  try {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(filePath);
    } catch (e) {
      return { ok: false, error: `stat failed: ${(e as Error).message}` };
    }
    if (!stat.isFile()) {
      return { ok: false, error: 'not a regular file' };
    }
    const readBytes = Math.min(wantedBytes, stat.size);
    if (readBytes === 0) {
      return { ok: false, error: 'empty file' };
    }

    const buffer = Buffer.alloc(readBytes);
    fd = await new Promise<number>((resolve, reject) =>
      fs.open(filePath, 'r', (err, openedFd) =>
        err ? reject(err) : resolve(openedFd),
      ),
    );
    let totalRead = 0;
    while (totalRead < readBytes) {
      const { bytesRead } = await new Promise<{ bytesRead: number }>(
        (resolve, reject) =>
          // Cast: TS5+ tightened Node Buffer typings against
          // ArrayBufferView (SharedArrayBuffer differentiation).
          // The runtime accepts a Buffer here as it always has.
          fs.read(
            fd!,
            buffer as unknown as NodeJS.ArrayBufferView,
            totalRead,
            readBytes - totalRead,
            totalRead,
            (err, br) => (err ? reject(err) : resolve({ bytesRead: br })),
          ),
      );
      if (bytesRead === 0) break;
      totalRead += bytesRead;
    }

    if (totalRead < readBytes && totalRead < 8) {
      return { ok: false, error: 'file too short to contain a header' };
    }

    // Buffer.buffer is `ArrayBufferLike` (covers SharedArrayBuffer too).
    // The pure parsers want a plain ArrayBuffer; copy via Uint8Array
    // ensures the slice is always a real ArrayBuffer regardless of the
    // underlying allocation.
    const slice = new Uint8Array(
      buffer.buffer,
      buffer.byteOffset,
      totalRead,
    ).slice();
    const arrayBuffer = slice.buffer;

    try {
      const meta = parseHeader(arrayBuffer, format);
      const shardInfo = detectShardInfo(fileName);
      if (shardInfo) meta.shardInfo = shardInfo;
      meta.fileSize = stat.size;
      // Aggregate sibling sizes only on the canonical shard. Doing it here
      // keeps the rest of the pipeline (autoTags, size filter, autotune)
      // ignorant of the shard topology — they just see `totalBytes`.
      if (isCanonicalShard(fileName)) {
        const agg = await sumShardBytes(filePath);
        meta.totalBytes = agg.totalBytes;
        meta.shardCount = agg.shardCount;
        if (agg.incomplete && agg.expectedTotal) {
          meta.warnings = [
            ...(meta.warnings ?? []),
            `incomplete shard set: ${agg.shardCount}/${agg.expectedTotal} files on disk`,
          ];
        }
      }
      return { ok: true, meta };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  } finally {
    if (fd !== undefined) {
      fs.close(fd, () => {
        /* intentionally ignored */
      });
    }
  }
}
