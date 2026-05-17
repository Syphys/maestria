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
// Sharded models: a model split across N files is one logical entity. Each
// shard is itself a GGUF (own header + own slice of the weights). We hash the
// tensor payload of EVERY shard, concatenated in shard order 1→N, into a
// single running digest. This is required for correctness: per-tensor splits
// (e.g. THIREUS "SPECIAL_TENSOR", 1 tensor/shard) keep almost no tensor data
// in shard 1 — hashing only shard 1's payload would collapse every such model
// to the empty-input digest. A shard with no GGUF header (naive blob split)
// is hashed whole.
//
// `general.uuid` (llama.cpp's weight-derived UUIDv5, `gguf-hash --uuid`) is the
// alternative D4 mentions; we don't depend on the external `gguf-hash` binary
// (Maestria ships only `llama-server`), so we compute the payload hash
// ourselves. When shard 1 carries `general.uuid` we still surface it for
// cross-referencing, but the canonical id stays our streamed payload digest.

import { createHash, type Hash } from 'node:crypto';
import { createReadStream, promises as fsp } from 'node:fs';
import {
  resolveCanonicalShardPath,
  findExistingSiblingShards,
} from '../shardFs';

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

  /** GGUF string = u64 length prefix + raw UTF-8 bytes. */
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
  /** `sha256:<hex>` of the concatenated payloads (shard order 1→N). */
  modelHash: string;
  /** `gguf-tensor-payload` when ≥1 shard had its header parsed and only its
   *  tensor data was hashed; `full-file` when no header could be parsed
   *  (single non-GGUF file). */
  scope: ModelHashScope;
  /** Tensor-data offset of shard 1 (0 when shard 1 wasn't a parseable GGUF).
   *  Informative only — the digest spans every shard. */
  dataOffset: number;
  /** Number of shard files actually hashed (1 for non-sharded). */
  shardCount: number;
  /** Sum of byte sizes across every hashed shard. */
  fileSize: number;
  /** Most recent mtime across every hashed shard (ms) — any shard edit
   *  bumps this so {@link isHashStale} triggers a recompute. */
  mtimeMs: number;
  /** `general.uuid` from shard 1's header, when present (cross-reference). */
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

/**
 * Locate a shard's tensor-data offset. Returns `null` when the file isn't a
 * GGUF (magic mismatch) or its header can't be parsed within
 * {@link MAX_HEADER_BYTES} — the caller then hashes the whole shard.
 */
async function ggufDataOffset(
  filePath: string,
  fileSize: number,
): Promise<{ offset: number; ggufUuid?: string } | null> {
  if (fileSize < 4) return null;
  let windowBytes = Math.min(INITIAL_HEADER_BYTES, fileSize);
  for (;;) {
    const header = await readHeaderWindow(filePath, windowBytes);
    if (header.length < 4 || header.readUInt32LE(0) !== GGUF_MAGIC) {
      return null; // not a GGUF shard — caller hashes it whole
    }
    try {
      return new HeaderWalker(header).findTensorDataOffset();
    } catch (e) {
      if (e instanceof NeedMoreBytes && windowBytes < fileSize) {
        windowBytes = Math.min(windowBytes * 2, fileSize, MAX_HEADER_BYTES);
        if (windowBytes >= MAX_HEADER_BYTES) return null; // pathological
        continue;
      }
      return null; // malformed despite magic → full-file fallback
    }
  }
}

function streamInto(
  hash: Hash,
  filePath: string,
  start: number,
  onChunk?: (n: number) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath, {
      start,
      highWaterMark: 4 * 1024 * 1024,
    });
    stream.on('data', (chunk: Buffer) => {
      // Cast: see readHeaderWindow — TS5+ Buffer/ArrayBufferView tightening.
      hash.update(chunk as unknown as Uint8Array);
      onChunk?.(chunk.length);
    });
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
}

type ShardPlan = {
  path: string;
  /** Byte offset to start hashing from (0 = whole file). */
  start: number;
  size: number;
  mtimeMs: number;
  /** True when the GGUF header was parsed and only the payload is hashed. */
  parsed: boolean;
  /** Only set for shard 1. */
  ggufUuid?: string;
};

/**
 * Compute the stable model hash for a model file. Resolves the canonical
 * shard (shard 1), enumerates every existing sibling shard in order, and
 * hashes the concatenation of each shard's tensor payload (D4). Streamed —
 * never loads weights into memory.
 *
 * Callers should cache the result keyed by (fileSize, mtimeMs) and only
 * recompute when {@link isHashStale} is true. A metadata-only edit on any
 * shard bumps that shard's mtime so a recompute is triggered — but the
 * payload digest is unchanged, so R7 portable matching still holds.
 */
export async function computeModelHash(
  filePath: string,
  opts: {
    onProgress?: (bytesRead: number, total: number) => void;
  } = {},
): Promise<ModelHashResult> {
  const t0 = Date.now();
  const canonical = await resolveCanonicalShardPath(filePath);
  const shards = await findExistingSiblingShards(canonical); // ordered 1→N, ≥1

  // Pass 1: stat + locate each shard's payload start.
  const plans: ShardPlan[] = [];
  for (let i = 0; i < shards.length; i++) {
    const p = shards[i];
    // eslint-disable-next-line no-await-in-loop
    const st = await fsp.stat(p);
    // eslint-disable-next-line no-await-in-loop
    const gguf = await ggufDataOffset(p, st.size);
    plans.push({
      path: p,
      start: gguf ? Math.min(gguf.offset, st.size) : 0,
      size: st.size,
      mtimeMs: st.mtimeMs,
      parsed: gguf !== null,
      ggufUuid: i === 0 ? gguf?.ggufUuid : undefined,
    });
  }

  const totalPayload = plans.reduce(
    (acc, p) => acc + Math.max(p.size - p.start, 0),
    0,
  );

  // Pass 2: stream every shard's payload into one running digest.
  const hash = createHash('sha256');
  let read = 0;
  for (const p of plans) {
    // eslint-disable-next-line no-await-in-loop
    await streamInto(hash, p.path, p.start, (n) => {
      read += n;
      opts.onProgress?.(read, totalPayload);
    });
  }

  return {
    modelHash: 'sha256:' + hash.digest('hex'),
    scope: plans.some((p) => p.parsed) ? 'gguf-tensor-payload' : 'full-file',
    dataOffset: plans[0]?.start ?? 0,
    shardCount: plans.length,
    fileSize: plans.reduce((acc, p) => acc + p.size, 0),
    mtimeMs: plans.reduce((acc, p) => Math.max(acc, p.mtimeMs), 0),
    ggufUuid: plans[0]?.ggufUuid,
    durationMs: Date.now() - t0,
  };
}

/**
 * Cheap staleness check: recompute when the aggregate filesize or the newest
 * shard mtime changed. A metadata-only edit on any shard changes that shard's
 * mtime (so this returns true and we recompute), but the tensor-payload digest
 * stays identical — exactly the D4 intent.
 */
export async function isHashStale(
  filePath: string,
  cached: { fileSize: number; mtimeMs: number } | null,
): Promise<boolean> {
  if (!cached) return true;
  try {
    const canonical = await resolveCanonicalShardPath(filePath);
    const shards = await findExistingSiblingShards(canonical);
    if (shards.length === 0) return true;
    let totalBytes = 0;
    let newest = 0;
    for (const s of shards) {
      // eslint-disable-next-line no-await-in-loop
      const st = await fsp.stat(s);
      totalBytes += st.size;
      newest = Math.max(newest, st.mtimeMs);
    }
    return totalBytes !== cached.fileSize || newest !== cached.mtimeMs;
  } catch {
    return true; // can't stat → assume stale, force recompute
  }
}
