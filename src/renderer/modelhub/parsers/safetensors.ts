/**
 * Safetensors header parser.
 * Format: 8 bytes LE u64 = header JSON length, then UTF-8 JSON.
 * Spec: https://github.com/huggingface/safetensors
 *
 * Pure: takes an ArrayBuffer that contains at least the first 8 bytes + the
 * JSON header (typically <1 MB for big LLMs). The tensor data block is not read.
 */

import { HeaderMeta, ModelArchitecture, Modality } from '../types';

interface SafetensorsTensorEntry {
  dtype: string;
  shape: number[];
  data_offsets?: [number, number];
}

interface SafetensorsHeaderJSON {
  __metadata__?: Record<string, string>;
  [tensorName: string]:
    | SafetensorsTensorEntry
    | Record<string, string>
    | undefined;
}

const DTYPE_TO_BYTES: Record<string, number> = {
  F64: 8,
  F32: 4,
  F16: 2,
  BF16: 2,
  F8_E4M3: 1,
  F8_E5M2: 1,
  I64: 8,
  I32: 4,
  I16: 2,
  I8: 1,
  U64: 8,
  U32: 4,
  U16: 2,
  U8: 1,
  BOOL: 1,
};

const DTYPE_TO_QUANTIZATION_LABEL: Record<string, string> = {
  F32: 'FP32',
  F16: 'FP16',
  BF16: 'BF16',
  F8_E4M3: 'FP8_E4M3',
  F8_E5M2: 'FP8_E5M2',
};

/** Heuristic architecture detection from tensor name patterns. */
function detectArchFromTensors(
  names: string[],
  metadata: Record<string, string>,
): {
  architecture: ModelArchitecture | string;
  modality: Modality | undefined;
  isLora: boolean;
} {
  // 1. Check explicit metadata first (most authoritative)
  const metaArch =
    metadata['modelspec.architecture'] ||
    metadata['architecture'] ||
    metadata['model_type'];
  if (metaArch) {
    const norm = metaArch.toLowerCase();
    if (norm.includes('flux'))
      return { architecture: 'flux', modality: 'image', isLora: false };
    if (norm.includes('sdxl'))
      return { architecture: 'sdxl', modality: 'image', isLora: false };
    if (norm.includes('stable-diffusion') || norm.includes('stablediffusion'))
      return { architecture: 'sd', modality: 'image', isLora: false };
    if (norm.includes('llama'))
      return { architecture: 'llama', modality: 'text', isLora: false };
    if (norm.includes('mistral'))
      return { architecture: 'mistral', modality: 'text', isLora: false };
    if (norm.includes('qwen'))
      return { architecture: 'qwen', modality: 'text', isLora: false };
    if (norm.includes('gemma'))
      return { architecture: 'gemma', modality: 'text', isLora: false };
    if (norm.includes('phi'))
      return { architecture: 'phi', modality: 'text', isLora: false };
    if (norm.includes('whisper'))
      return { architecture: 'whisper', modality: 'audio', isLora: false };
    if (norm.includes('clip'))
      return { architecture: 'clip', modality: 'multimodal', isLora: false };
    if (norm.includes('t5'))
      return { architecture: 't5', modality: 'text', isLora: false };
    if (norm.includes('bert'))
      return { architecture: 'bert', modality: 'embedding', isLora: false };
  }

  // 2. LoRA detection by tensor name pattern
  const loraPattern = /\.(lora_(A|B|up|down)|lora_alpha|lora_magnitude)/i;
  if (names.some((n) => loraPattern.test(n))) {
    return { architecture: 'lora', modality: undefined, isLora: true };
  }

  // 3. Diffusion model detection
  if (
    names.some(
      (n) =>
        n.startsWith('unet.') ||
        n.startsWith('model.diffusion_model.') ||
        (n.startsWith('text_encoder') &&
          names.some((m) => m.startsWith('vae.'))),
    )
  ) {
    // Distinguish SDXL (has text_encoder_2) vs SD vs Flux
    if (
      names.some(
        (n) => n.includes('double_blocks') || n.includes('single_blocks'),
      )
    )
      return { architecture: 'flux', modality: 'image', isLora: false };
    if (
      names.some(
        (n) =>
          n.startsWith('text_encoder_2.') ||
          n.startsWith('conditioner.embedders.1.'),
      )
    )
      return { architecture: 'sdxl', modality: 'image', isLora: false };
    return { architecture: 'sd', modality: 'image', isLora: false };
  }

  // 4. LLM detection by transformers naming
  const hasLayers = names.some((n) => /^model\.layers\.\d+\./.test(n));
  const hasLmHead = names.some(
    (n) => n === 'lm_head.weight' || n.endsWith('.lm_head.weight'),
  );
  if (hasLayers || hasLmHead) {
    // Try to disambiguate by characteristic tensor names
    if (names.some((n) => n.includes('rope.freqs')))
      return { architecture: 'llama', modality: 'text', isLora: false };
    return { architecture: 'unknown', modality: 'text', isLora: false };
  }

  // 5. Whisper detection
  if (names.some((n) => n.startsWith('encoder.blocks.') && n.includes('attn')))
    return { architecture: 'whisper', modality: 'audio', isLora: false };

  return { architecture: 'unknown', modality: undefined, isLora: false };
}

function tensorParamCount(entry: SafetensorsTensorEntry): number {
  if (!Array.isArray(entry.shape)) return 0;
  return entry.shape.reduce((acc, d) => acc * d, 1);
}

function pickDominantDtype(
  entries: SafetensorsTensorEntry[],
): string | undefined {
  // The dtype that occupies the most bytes wins. We size by params * dtype_bytes.
  const byBytes: Record<string, number> = {};
  for (const e of entries) {
    const bytes = (DTYPE_TO_BYTES[e.dtype] ?? 0) * tensorParamCount(e);
    byBytes[e.dtype] = (byBytes[e.dtype] ?? 0) + bytes;
  }
  let best: string | undefined;
  let bestBytes = 0;
  for (const [dt, b] of Object.entries(byBytes)) {
    if (b > bestBytes) {
      bestBytes = b;
      best = dt;
    }
  }
  return best;
}

export interface ParseSafetensorsOptions {
  /** Maximum header size we'll accept (bytes). Default 100 MB — pathologically large headers fail. */
  maxHeaderBytes?: number;
}

export function parseSafetensorsHeader(
  buf: ArrayBuffer,
  options: ParseSafetensorsOptions = {},
): HeaderMeta {
  if (buf.byteLength < 8) {
    throw new Error('safetensors buffer too small for header length');
  }

  const view = new DataView(buf);
  const lenLo = view.getUint32(0, true);
  const lenHi = view.getUint32(4, true);
  if (lenHi !== 0 && BigInt(lenHi) >= BigInt(0x100000)) {
    throw new Error('safetensors header length absurdly large');
  }
  const headerLen =
    lenHi === 0 ? lenLo : Number((BigInt(lenHi) << 32n) | BigInt(lenLo));

  const cap = options.maxHeaderBytes ?? 100 * 1024 * 1024;
  if (headerLen > cap) {
    throw new Error(`safetensors header exceeds cap (${headerLen} > ${cap})`);
  }
  if (8 + headerLen > buf.byteLength) {
    throw new Error(
      `safetensors buffer too small for full header (need ${8 + headerLen}, have ${buf.byteLength})`,
    );
  }

  const headerBytes = new Uint8Array(buf, 8, headerLen);
  const headerJson = new TextDecoder('utf-8').decode(headerBytes);
  let header: SafetensorsHeaderJSON;
  try {
    header = JSON.parse(headerJson);
  } catch (e) {
    throw new Error(
      `safetensors header JSON parse failed: ${(e as Error).message}`,
    );
  }

  const metadata = header.__metadata__ || {};
  const tensorEntries: SafetensorsTensorEntry[] = [];
  const tensorNames: string[] = [];
  for (const [k, v] of Object.entries(header)) {
    if (k === '__metadata__') continue;
    if (v && typeof v === 'object' && 'dtype' in v && 'shape' in v) {
      tensorEntries.push(v as SafetensorsTensorEntry);
      tensorNames.push(k);
    }
  }

  const totalParams = tensorEntries.reduce(
    (acc, e) => acc + tensorParamCount(e),
    0,
  );
  const dominantDtype = pickDominantDtype(tensorEntries);
  const quantization = dominantDtype
    ? DTYPE_TO_QUANTIZATION_LABEL[dominantDtype] || dominantDtype
    : undefined;

  const detected = detectArchFromTensors(tensorNames, metadata);

  const meta: HeaderMeta = {
    format: 'safetensors',
    architecture: detected.architecture,
    name: metadata['modelspec.title'] || metadata['title'] || undefined,
    basename: metadata['modelspec.title'] || undefined,
    author: metadata['modelspec.author'] || metadata['author'] || undefined,
    paramCount: totalParams > 0 ? totalParams : undefined,
    quantization,
    modality: detected.modality,
    isLora: detected.isLora || undefined,
    rawMetadata: metadata,
  };

  return meta;
}
