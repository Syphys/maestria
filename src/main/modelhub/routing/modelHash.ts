// R0.2 — Stable model hash for portable behavioral signatures.
// Spec: SEMANTIC_ROUTING_FEATURES.md §R0.2 ; arbitration: DECISIONS.md D4.
//
// D4 (authoritative): hash the GGUF **tensor payload**, NOT the whole file.
// Rationale: `gguf-set-metadata` (chat-template fix, adding `general.uuid`,
// quant-name corrections, …) rewrites bytes in the header/KV region but leaves
// every weight untouched. A whole-file SHA-256 would change on those edits and
// silently break R7 portable-signature matching across machines. Hashing only
// the tensor-data section (header parsed, data offset located, then streamed
// from that offset to EOF) yields the same digest before and after any
// metadata-only edit.
//
// `general.uuid` (llama.cpp's weight-derived UUIDv5, `gguf-hash --uuid`) is the
// alternative D4 mentions; we don't depend on the external `gguf-hash` binary
// (Maestria ships only `llama-server`), so we compute the payload hash
// ourselves. When the file carries `general.uuid` we still surface it for
// cross-referencing, but the canonical id stays our streamed payload digest.

import { createHash } from 'node:crypto';
import { createReadStream, promises as fsp } from 'node:fs';
import { extname } from 'node:path';
import { resolveCanonicalShardPath } from '../shardFs';

/** GGUF magic, little-endian 'GGUF'. */
const GGUF_MAGIC = 0x46554747;
/** Default tensor-data alignment when `general.alignment` is absent. */
const DEFAULT_ALIGNMENT = 32;
/** Initial header read window. Big enough for almost every model in one shot. */
const INITIAL_HEADER_BYTES = 8 * 1024 * 1024;
/** Hard cap on the header window before we give up and fall back to full-file. */
const MAX_HEADER_BYTES = 64 * 1024 * 1024;

/**
 * Mirrors ggml's `gguf_metadata_value_type`. Kept local (no import from the
 * renderer parser) so the main process has zero renderer coupling here.
 */
enum GgufType {
  UINT8 = 0,
  INT8 = 1,
  UINT16 = 2,
  INT16 = 3,
  UINT32 = 4,
  INT32 = 5,
  FLOAT32 = 6,
  BOOL = 7,
  STRING = 8,
  ARRAY = 9,
  UINT64 = 10,
  INT64 = 11,
  FLOAT64 = 12,
}

function primitiveSize(t: GgufType): number {
  switch (t) {
    case GgufType.UINT8:
    case GgufType.INT8:
    case GgufType.BOOL:
      return 1;
    case GgufType.UINT16:
    case GgufType.INT16:
      return 2;
    case GgufType.UINT32:
    case GgufType.INT32:
    case GgufType.FLOAT32:
      return 4;
    case GgufType.UINT64:
    case GgufType.INT64:
    case GgufType.FLOAT64:
      return 8;
    default:
      throw new Error(`primitiveSize: ${t} is not a primitive type`);
  }
}

/** Thrown when the header parser would read past the buffer we hold. The
 *  driver grows the read window and retries. */
class NeedMoreBytes extends Error {
  constructor() {
    super('GGUF header exceeds current read window');
    this.name = 'NeedMoreBytes';
  }
}

/**
 * Walks just enough of a GGUF header (magic, version, counts, every KV pair,
 * every tensor-info record) to compute where the tensor data section begins.
 * Allocates nothing for skipped values. Throws {@link NeedMoreBytes} when the
 * buffer is too small to finish.
 */
class HeaderWalker {
  private view: DataView;
  pos = 0;

  constructor(buf: Buffer) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  private need(n: number): void {
    if (this.pos + n > this.view.byteLength) throw new NeedMoreBytes();
  }

  private u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  /** Reads a u64 as a JS number — GGUF lengths/offsets stay well under 2^53. */
  private u64(): number {
    this.need(8);
    const lo = this.view.getUint32(this.pos, true);
    const hi = this.view.getUint32(this.pos + 4, true);
    this.pos += 8;
    if (hi === 0) return lo;
    const big = (BigInt(hi) << 32n) | BigInt(lo);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('GGUF u64 exceeds JS safe integer');
    }
    return Number(big);
  }

  private skipBytes(n: number): void {
    this.need(n);
    this.pos += n;
  }

  /** GGUF string = u64 length prefix + raw UTF-8 bytes. We never decode it. */
  private skipString(): string {
    const len = this.u64();
    this.need(len);
    const bytes = new Uint8Array(
      this.view.buffer,
      this.view.byteOffset + this.pos,
      len,
    );
    this.pos += len;
    return Buffer.from(bytes).toString('utf-8');
  }

  /** Reads a primitive value (used only for the few KVs we care about). */
  private readPrimitive(type: GgufType): number {
    switch (type) {
      case GgufType.UINT8:
        this.need(1);
        return this.view.getUint8(this.pos++);
      case GgufType.INT8:
        this.need(1);
        return this.view.getInt8(this.pos++);
      case GgufType.UINT16: {
        this.need(2);
        const v = this.view.getUint16(this.pos, true);
        this.pos += 2;
        return v;
      }
      case GgufType.INT16: {
        this.need(2);
        const v = this.view.getInt16(this.pos, true);
        this.pos += 2;
        return v;
      }
      case GgufType.UINT32:
      case GgufType.INT32:
        return this.u32();
      case GgufType.UINT64:
      case GgufType.INT64:
        return this.u64();
      default:
        throw new Error(`readPrimitive: ${type} is not an integer type`);
    }
  }

  private skipValue(type: GgufType): void {
    switch (type) {
      case GgufType.UINT8:
      case GgufType.INT8:
      case GgufType.BOOL:
        this.skipBytes(1);
        break;
      case GgufType.UINT16:
      case GgufType.INT16:
        this.skipBytes(2);
        break;
      case GgufType.UINT32:
      case GgufType.INT32:
      case GgufType.FLOAT32:
        this.skipBytes(4);
        break;
      case GgufType.UINT64:
      case GgufType.INT64:
      case GgufType.FLOAT64:
        this.skipBytes(8);
        break;
      case GgufType.STRING:
        this.skipString();
        break;
      case GgufType.ARRAY: {
        const inner = this.u32() as GgufType;
        const length = this.u64();
        if (inner === GgufType.STRING) {
          for (let i = 0; i < length; i++) this.skipString();
        } else if (inner === GgufType.ARRAY) {
          for (let i = 0; i < length; i++) this.skipValue(inner);
        } else {
          this.skipBytes(length * primitiveSize(inner));
        }
        break;
      }
      default:
        throw new Error(`skipValue: unknown GGUF value type ${type}`);
    }
  }

  /**
   * @returns the absolute byte offset where the tensor data section starts,
   *          plus `general.uuid` if the header advertised one.
   */
  findTensorDataOffset(): { offset: number; ggufUuid?: string } {
    const magic = this.u32();
    if (magic !== GGUF_MAGIC) throw new Error('not a GGUF file (bad magic)');
    const version = this.u32();
    if (version < 1 || version > 3) {
      throw new Error(`unsupported GGUF version ${version}`);
    }
    // v1 used u32 counts; v2/v3 use u64. String lengths are u64 in every
    // version the codebase supports (matches renderer/modelhub/parsers/gguf.ts).
    const tensorCount = version === 1 ? this.u32() : this.u64();
    const kvCount = version === 1 ? this.u32() : this.u64();

    let alignment = DEFAULT_ALIGNMENT;
    let ggufUuid: string | undefined;

    for (let i = 0; i < kvCount; i++) {
      const key = this.skipString();
      const type = this.u32() as GgufType;
      if (key === 'general.alignment') {
        alignment = this.readPrimitive(type) || DEFAULT_ALIGNMENT;
      } else if (key === 'general.uuid' && type === GgufType.STRING) {
        ggufUuid = this.skipString();
      } else {
        this.skipValue(type);
      }
    }

    // Tensor info records: name(string) n_dims(u32) dims(u64×n) type(u32) offset(u64).
    for (let i = 0; i < tensorCount; i++) {
      this.skipString();
      const nDims = this.u32();
      this.skipBytes(nDims * 8);
      this.u32(); // ggml_type
      this.u64(); // tensor offset (relative to data section start)
    }

    const offset = Math.ceil(this.pos / alignment) * alignment;
    return { offset, ggufUuid };
  }
}

export type ModelHashScope = 'gguf-tensor-payload' | 'full-file';

export type ModelHashResult = {
  /** `sha256:<hex>` of the bytes covered by {@link ModelHashResult.scope}. */
  modelHash: string;
  /** What was hashed. `full-file` is the graceful fallback for non-GGUF
   *  files (safetensors, …) or an unparseable / pathologically large header. */
  scope: ModelHashScope;
  /** Absolute byte offset hashing started at (0 for `full-file`). */
  dataOffset: number;
  /** Size of the canonical file in bytes. */
  fileSize: number;
  /** mtime of the canonical file (ms). */
  mtimeMs: number;
  /** `general.uuid` from the GGUF header, when present (cross-reference only). */
  ggufUuid?: string;
  durationMs: number;
};

async function readHeaderWindow(
  filePath: string,
  bytes: number,
): Promise<Buffer> {
  const fh = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    // Cast: TS5+ tightened Node Buffer typings against ArrayBufferView
    // (SharedArrayBuffer differentiation). Runtime accepts a Buffer as it
    // always has — same workaround as parseHeader.ts.
    const { bytesRead } = await fh.read(
      buf as unknown as NodeJS.ArrayBufferView,
      0,
      bytes,
      0,
    );
    return bytesRead === bytes ? buf : buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

function streamSha256(
  filePath: string,
  start: number,
  onProgress?: (bytesRead: number, total: number) => void,
  total = 0,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath, {
      start,
      highWaterMark: 4 * 1024 * 1024,
    });
    let read = 0;
    stream.on('data', (chunk: Buffer) => {
      // Cast: see readHeaderWindow — TS5+ Buffer/ArrayBufferView tightening.
      hash.update(chunk as unknown as Uint8Array);
      read += chunk.length;
      onProgress?.(read, total);
    });
    stream.on('end', () => resolve('sha256:' + hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Compute the stable model hash for a model file. Resolves the canonical
 * shard (shard 1) first, per the codebase shard convention. Streamed — never
 * loads the weights into memory.
 *
 * For GGUF: parses the header, locates the tensor-data offset, and hashes
 * from there to EOF (D4). For anything else, or if the header can't be parsed
 * within {@link MAX_HEADER_BYTES}, it falls back to a full-file hash and says
 * so via `scope`.
 *
 * Callers should cache the result keyed by (path, fileSize, mtimeMs) and only
 * recompute when {@link isHashStale} is true. A metadata-only edit bumps mtime
 * so a recompute is triggered — but the GGUF-payload digest is unchanged, so
 * R7 portable matching still holds.
 */
export async function computeModelHash(
  filePath: string,
  opts: {
    onProgress?: (bytesRead: number, total: number) => void;
  } = {},
): Promise<ModelHashResult> {
  const canonical = await resolveCanonicalShardPath(filePath);
  const stats = await fsp.stat(canonical);
  const fileSize = stats.size;
  const t0 = Date.now();

  let scope: ModelHashScope = 'full-file';
  let dataOffset = 0;
  let ggufUuid: string | undefined;

  if (extname(canonical).toLowerCase() === '.gguf') {
    let windowBytes = Math.min(INITIAL_HEADER_BYTES, fileSize);
    // Grow the header window until the walker succeeds or we hit the cap.
    for (;;) {
      try {
        const header = await readHeaderWindow(canonical, windowBytes);
        const res = new HeaderWalker(header).findTensorDataOffset();
        dataOffset = Math.min(res.offset, fileSize);
        ggufUuid = res.ggufUuid;
        scope = 'gguf-tensor-payload';
        break;
      } catch (e) {
        if (e instanceof NeedMoreBytes && windowBytes < fileSize) {
          windowBytes = Math.min(windowBytes * 2, fileSize, MAX_HEADER_BYTES);
          if (windowBytes >= MAX_HEADER_BYTES) {
            // Pathological header — degrade to full-file rather than fail.
            scope = 'full-file';
            dataOffset = 0;
            break;
          }
          continue;
        }
        // Not GGUF after all, or a malformed header: full-file fallback.
        scope = 'full-file';
        dataOffset = 0;
        break;
      }
    }
  }

  const modelHash = await streamSha256(
    canonical,
    dataOffset,
    opts.onProgress,
    Math.max(fileSize - dataOffset, 0),
  );

  return {
    modelHash,
    scope,
    dataOffset,
    fileSize,
    mtimeMs: stats.mtimeMs,
    ggufUuid,
    durationMs: Date.now() - t0,
  };
}

/**
 * Cheap staleness check: recompute when filesize or mtime changed. A
 * metadata-only edit changes mtime (so this returns true and we recompute),
 * but the GGUF tensor-payload digest stays identical — exactly the D4 intent.
 */
export async function isHashStale(
  filePath: string,
  cached: { fileSize: number; mtimeMs: number } | null,
): Promise<boolean> {
  if (!cached) return true;
  try {
    const canonical = await resolveCanonicalShardPath(filePath);
    const stats = await fsp.stat(canonical);
    return stats.size !== cached.fileSize || stats.mtimeMs !== cached.mtimeMs;
  } catch {
    return true; // can't stat → assume stale, force recompute
  }
}
