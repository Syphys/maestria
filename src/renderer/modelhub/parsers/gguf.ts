/**
 * GGUF v1/v2/v3 header parser.
 * Spec: https://github.com/ggerganov/ggml/blob/master/docs/gguf.md
 *
 * Pure: takes an ArrayBuffer (typically the first few hundred KB of the file)
 * and returns a HeaderMeta. Does not require the full file — large array values
 * (e.g. tokenizer vocab) are skipped, not stored.
 */

import { HeaderMeta, ModelArchitecture, Modality } from '../types';

const GGUF_MAGIC = 0x46554747; // 'GGUF' little-endian

/**
 * Order matters — must match ggml/llama.cpp's gguf_metadata_value_type enum.
 * Source: https://github.com/ggerganov/ggml/blob/master/include/ggml.h
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

/**
 * Mapping from GGUF `general.file_type` (an integer) to a human-readable
 * quantization label. Source: llama.cpp's llama_ftype enum.
 */
const FILE_TYPE_LABELS: Record<number, string> = {
  0: 'F32',
  1: 'F16',
  2: 'Q4_0',
  3: 'Q4_1',
  4: 'Q4_1_F16',
  7: 'Q8_0',
  8: 'Q5_0',
  9: 'Q5_1',
  10: 'Q2_K',
  11: 'Q3_K_S',
  12: 'Q3_K_M',
  13: 'Q3_K_L',
  14: 'Q4_K_S',
  15: 'Q4_K_M',
  16: 'Q5_K_S',
  17: 'Q5_K_M',
  18: 'Q6_K',
  19: 'IQ2_XXS',
  20: 'IQ2_XS',
  21: 'Q2_K_S',
  22: 'IQ3_XS',
  23: 'IQ3_XXS',
  24: 'IQ1_S',
  25: 'IQ4_NL',
  26: 'IQ3_S',
  27: 'IQ3_M',
  28: 'IQ2_S',
  29: 'IQ2_M',
  30: 'IQ4_XS',
  31: 'IQ1_M',
  32: 'BF16',
  33: 'Q4_0_4_4',
  34: 'Q4_0_4_8',
  35: 'Q4_0_8_8',
  36: 'TQ1_0',
  37: 'TQ2_0',
};

const ARCH_TO_MODALITY: Record<string, Modality> = {
  llama: 'text',
  mistral: 'text',
  qwen: 'text',
  qwen2: 'text',
  qwen3: 'text',
  phi: 'text',
  phi3: 'text',
  gemma: 'text',
  gemma2: 'text',
  falcon: 'text',
  mpt: 'text',
  gpt2: 'text',
  gptj: 'text',
  gptneox: 'text',
  bloom: 'text',
  baichuan: 'text',
  starcoder: 'text',
  starcoder2: 'text',
  rwkv: 'text',
  mamba: 'text',
  bert: 'embedding',
  t5: 'text',
  whisper: 'audio',
  clip: 'multimodal',
};

class Reader {
  private view: DataView;
  pos: number;

  constructor(buf: ArrayBuffer) {
    this.view = new DataView(buf);
    this.pos = 0;
  }

  remain(): number {
    return this.view.byteLength - this.pos;
  }

  u8(): number {
    const v = this.view.getUint8(this.pos);
    this.pos += 1;
    return v;
  }

  u16(): number {
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  i16(): number {
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }

  u32(): number {
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  i32(): number {
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  f32(): number {
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  f64(): number {
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  /** Reads a u64 as a JS number — safe up to 2^53. Throws on overflow. */
  u64(): number {
    const lo = this.view.getUint32(this.pos, true);
    const hi = this.view.getUint32(this.pos + 4, true);
    this.pos += 8;
    if (hi === 0) return lo;
    const big = (BigInt(hi) << 32n) | BigInt(lo);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('u64 value exceeds JS safe integer');
    }
    return Number(big);
  }

  i64(): number {
    const lo = this.view.getUint32(this.pos, true);
    const hi = this.view.getInt32(this.pos + 4, true);
    this.pos += 8;
    const big = (BigInt(hi) << 32n) | BigInt(lo);
    return Number(big);
  }

  string(): string {
    const len = this.u64();
    if (this.pos + len > this.view.byteLength) {
      throw new Error('truncated GGUF string');
    }
    const bytes = new Uint8Array(
      this.view.buffer,
      this.view.byteOffset + this.pos,
      len,
    );
    this.pos += len;
    return new TextDecoder('utf-8').decode(bytes);
  }

  skipString(): void {
    const len = this.u64();
    if (this.pos + len > this.view.byteLength) {
      throw new Error('truncated GGUF string (skip)');
    }
    this.pos += len;
  }

  /** Reads a single primitive or compound value of the given type. */
  readValue(type: GgufType): unknown {
    switch (type) {
      case GgufType.UINT8:
        return this.u8();
      case GgufType.INT8:
        return this.view.getInt8(this.pos++);
      case GgufType.UINT16:
        return this.u16();
      case GgufType.INT16:
        return this.i16();
      case GgufType.UINT32:
        return this.u32();
      case GgufType.INT32:
        return this.i32();
      case GgufType.FLOAT32:
        return this.f32();
      case GgufType.UINT64:
        return this.u64();
      case GgufType.INT64:
        return this.i64();
      case GgufType.FLOAT64:
        return this.f64();
      case GgufType.BOOL:
        return this.u8() !== 0;
      case GgufType.STRING:
        return this.string();
      case GgufType.ARRAY: {
        const innerType = this.u32() as GgufType;
        const length = this.u64();
        const arr: unknown[] = [];
        for (let i = 0; i < length; i++) arr.push(this.readValue(innerType));
        return arr;
      }
      default:
        throw new Error(`unknown GGUF value type: ${type}`);
    }
  }

  /** Skips a value of the given type without allocating. */
  skipValue(type: GgufType): void {
    switch (type) {
      case GgufType.UINT8:
      case GgufType.INT8:
      case GgufType.BOOL:
        this.pos += 1;
        break;
      case GgufType.UINT16:
      case GgufType.INT16:
        this.pos += 2;
        break;
      case GgufType.UINT32:
      case GgufType.INT32:
      case GgufType.FLOAT32:
        this.pos += 4;
        break;
      case GgufType.UINT64:
      case GgufType.INT64:
      case GgufType.FLOAT64:
        this.pos += 8;
        break;
      case GgufType.STRING:
        this.skipString();
        break;
      case GgufType.ARRAY: {
        const innerType = this.u32() as GgufType;
        const length = this.u64();
        if (innerType === GgufType.STRING) {
          for (let i = 0; i < length; i++) this.skipString();
        } else if (innerType === GgufType.ARRAY) {
          for (let i = 0; i < length; i++) this.skipValue(innerType);
        } else {
          this.pos += length * primitiveSize(innerType);
        }
        break;
      }
      default:
        throw new Error(`unknown GGUF value type (skip): ${type}`);
    }
  }
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
      throw new Error(`primitiveSize: ${t} is not primitive`);
  }
}

/** Keys we always decode (vs. skip). We now want everything to support exhaustive tagging. */
function isWantedKey(key: string): boolean {
  return true;
}

function paramCountFromSizeLabel(label?: string): number | undefined {
  if (!label) return undefined;
  const m = label.match(/^([0-9]+(?:\.[0-9]+)?)\s*([BMK]?)$/i);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  const unit = (m[2] || '').toUpperCase();
  if (unit === 'B') return Math.round(n * 1e9);
  if (unit === 'M') return Math.round(n * 1e6);
  if (unit === 'K') return Math.round(n * 1e3);
  return Math.round(n);
}

function buildMeta(kv: Record<string, unknown>): HeaderMeta {
  const arch = (kv['general.architecture'] as string) || undefined;
  // `general.file_type` is spec'd as UINT32 but some files store it as a string
  // (the human label directly). Handle both gracefully.
  const fileTypeRaw = kv['general.file_type'];
  let quantization: string | undefined;
  if (typeof fileTypeRaw === 'number' && Number.isFinite(fileTypeRaw)) {
    quantization = FILE_TYPE_LABELS[fileTypeRaw] || `type_${fileTypeRaw}`;
  } else if (typeof fileTypeRaw === 'string' && fileTypeRaw.length > 0) {
    quantization = fileTypeRaw;
  }
  const sizeLabel = (kv['general.size_label'] as string) || undefined;

  const archKey = arch || '';
  const get = (suffix: string): number | undefined => {
    const v = kv[`${archKey}.${suffix}`];
    return typeof v === 'number' ? v : undefined;
  };

  const meta: HeaderMeta = {
    format: 'gguf',
    architecture: (arch as ModelArchitecture | string) ?? 'unknown',
    name: (kv['general.name'] as string) || undefined,
    basename: (kv['general.basename'] as string) || undefined,
    author: (kv['general.author'] as string) || undefined,
    sizeLabel,
    paramCount: paramCountFromSizeLabel(sizeLabel),
    quantization,
    contextMax: get('context_length'),
    embeddingDim: get('embedding_length'),
    blockCount: get('block_count'),
    headCount: get('attention.head_count'),
    modality: arch ? ARCH_TO_MODALITY[arch] : undefined,
    rawMetadata: kv,
  };

  return meta;
}

export interface ParseGgufOptions {
  /** Cap on KV pairs we'll decode-or-skip. Default 4096 — well above any sane model. */
  maxKv?: number;
}

export function parseGgufHeader(
  buf: ArrayBuffer,
  options: ParseGgufOptions = {},
): HeaderMeta {
  const reader = new Reader(buf);
  if (reader.remain() < 12) {
    throw new Error('GGUF buffer too small for magic + version');
  }
  const magic = reader.u32();
  if (magic !== GGUF_MAGIC) {
    throw new Error('not a GGUF file (bad magic)');
  }
  const version = reader.u32();
  if (version < 1 || version > 3) {
    throw new Error(`unsupported GGUF version: ${version}`);
  }

  const tensorCount = version === 1 ? reader.u32() : reader.u64();
  const kvCount = version === 1 ? reader.u32() : reader.u64();
  void tensorCount;

  const cap = Math.min(kvCount, options.maxKv ?? 4096);
  const kv: Record<string, unknown> = {};
  const warnings: string[] = [];

  for (let i = 0; i < cap; i++) {
    if (reader.remain() < 12) {
      warnings.push(`truncated at KV ${i}/${kvCount}: insufficient buffer`);
      break;
    }
    let key: string | undefined;
    try {
      key = reader.string();
      const type = reader.u32() as GgufType;
      if (isWantedKey(key)) {
        kv[key] = reader.readValue(type);
      } else {
        reader.skipValue(type);
      }
    } catch (e) {
      const where = key ? `KV "${key}"` : `KV ${i}`;
      warnings.push(`truncated/failed at ${where}: ${(e as Error).message}`);
      break;
    }
  }

  if (kvCount > cap) {
    warnings.push(`stopped after ${cap} KVs, ${kvCount - cap} more present`);
  }

  const meta = buildMeta(kv);
  if (warnings.length) meta.warnings = warnings;
  return meta;
}
