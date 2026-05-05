/**
 * Header parser dispatch — picks the right parser based on file extension.
 * All parsers are pure (ArrayBuffer in, HeaderMeta out).
 */

import { HeaderMeta, ModelFormat } from '../types';
import { parseGgufHeader } from './gguf';
import { parseSafetensorsHeader } from './safetensors';
import { sniffPytorchHeader, pytorchFormatFromExtension } from './pytorch';

/** Detects the model format from a filename's extension. */
export function detectFormat(fileName: string): ModelFormat {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.gguf')) return 'gguf';
  if (lower.endsWith('.safetensors')) return 'safetensors';
  const ptFormat = pytorchFormatFromExtension(lower.split('.').pop() || '');
  if (ptFormat) return ptFormat;
  return 'unknown';
}

/** True when the extension looks like a model file we can do something useful with. */
export function isSupportedModelFile(fileName: string): boolean {
  return detectFormat(fileName) !== 'unknown';
}

/**
 * Parse a header buffer based on declared format.
 * Throws if the buffer doesn't match the declared format.
 */
export function parseHeader(buf: ArrayBuffer, format: ModelFormat): HeaderMeta {
  switch (format) {
    case 'gguf':
      return parseGgufHeader(buf);
    case 'safetensors':
      return parseSafetensorsHeader(buf);
    case 'pytorch-bin':
    case 'pytorch-ckpt':
      return sniffPytorchHeader(buf, format);
    case 'unknown':
    default:
      return {
        format: 'unknown',
        architecture: 'unknown',
        warnings: ['unsupported file format'],
      };
  }
}

/**
 * How many bytes from the start of the file the parser needs.
 * Reasonable defaults — bigger for safetensors (header can be MB-scale on big LLMs).
 */
export function suggestedReadBytes(format: ModelFormat): number {
  switch (format) {
    case 'gguf':
      return 1024 * 1024; // 1 MB — enough for KV metadata of any sane model
    case 'safetensors':
      return 16 * 1024 * 1024; // 16 MB — generous; the JSON header is rarely > 5 MB
    case 'pytorch-bin':
    case 'pytorch-ckpt':
      return 4096; // just need to sniff the container magic
    default:
      return 4096;
  }
}

export { parseGgufHeader, parseSafetensorsHeader, sniffPytorchHeader };
