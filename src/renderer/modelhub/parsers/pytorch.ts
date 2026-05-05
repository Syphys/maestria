/**
 * Best-effort sniff for PyTorch `.bin` / `.ckpt` files.
 *
 * Both formats wrap a Python pickle (or a ZIP of pickles + tensor blobs since
 * PyTorch 1.6). We deliberately do NOT execute the pickle — pickles can run
 * arbitrary code on load. We only check the container format and return enough
 * for the UI to show "PyTorch checkpoint, parsing not supported" with a known
 * format label.
 */

import { HeaderMeta, ModelFormat } from '../types';

const ZIP_MAGIC = 0x04034b50; // 'PK\x03\x04' (LE)
const PICKLE_PROTO_MARKER = 0x80; // \x80 followed by version byte

export function sniffPytorchHeader(
  buf: ArrayBuffer,
  format: 'pytorch-bin' | 'pytorch-ckpt',
): HeaderMeta {
  const meta: HeaderMeta = {
    format,
    architecture: 'unknown',
    warnings: [
      'PyTorch checkpoint: tensor metadata not parsed (pickle execution avoided for safety)',
    ],
  };

  if (buf.byteLength < 4) {
    meta.warnings!.push('file too small to detect container');
    return meta;
  }

  const view = new DataView(buf);
  const u32 = view.getUint32(0, true);

  if (u32 === ZIP_MAGIC) {
    meta.rawMetadata = { container: 'zip' };
    return meta;
  }

  const b0 = view.getUint8(0);
  if (b0 === PICKLE_PROTO_MARKER) {
    const protoVersion = view.getUint8(1);
    meta.rawMetadata = { container: 'pickle', protoVersion };
    return meta;
  }

  meta.warnings!.push(
    'unrecognized container (neither zip nor pickle protocol marker)',
  );
  return meta;
}

export function pytorchFormatFromExtension(
  ext: string,
): ModelFormat | undefined {
  const lower = ext.toLowerCase().replace(/^\./, '');
  if (lower === 'bin') return 'pytorch-bin';
  if (lower === 'ckpt' || lower === 'pt' || lower === 'pth')
    return 'pytorch-ckpt';
  return undefined;
}
