/**
 * Smoke test for modelhub header parsers.
 *
 * Run:
 *   npx ts-node --transpile-only scripts/modelhub-smoke.ts
 *   npx ts-node --transpile-only scripts/modelhub-smoke.ts D:/models
 *
 * Builds synthetic GGUF and safetensors buffers in memory, asserts the parsers
 * extract the expected fields, then optionally probes one real file per format
 * from the given folder.
 */
/// <reference types="node" />

// Resolve `-/*` webpack alias when running under ts-node.
require('tsconfig-paths/register');

import fs from 'fs';
import path from 'path';
import { parseGgufHeader } from '../src/renderer/modelhub/parsers/gguf';
import { parseSafetensorsHeader } from '../src/renderer/modelhub/parsers/safetensors';
import { computeAutoTags } from '../src/renderer/modelhub/autoTags';
import { enrichLocal } from '../src/main/modelhub/enrichLocal';
import {
  guessRepoCandidates,
  stripQuantizationSuffixes,
} from '../src/main/modelhub/hfHeuristic';
import { enrichHf } from '../src/main/modelhub/enrichHf';
import { enrichFolder } from '../src/main/modelhub/enrichFolder';
import { listModelFiles } from '../src/main/modelhub/listModelFiles';

// ----- GGUF synthetic builder ------------------------------------------------

const enum GgufType {
  UINT32 = 4,
  STRING = 8,
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function buildGgufBuffer(): ArrayBuffer {
  const kvs: Array<{
    key: string;
    type: GgufType;
    write: (b: BufferWriter) => void;
  }> = [
    {
      key: 'general.architecture',
      type: GgufType.STRING,
      write: (b) => b.writeGgufString('llama'),
    },
    {
      key: 'general.name',
      type: GgufType.STRING,
      write: (b) => b.writeGgufString('Test Llama Model'),
    },
    {
      key: 'general.basename',
      type: GgufType.STRING,
      write: (b) => b.writeGgufString('TestLlama-8B'),
    },
    {
      key: 'general.size_label',
      type: GgufType.STRING,
      write: (b) => b.writeGgufString('8B'),
    },
    {
      key: 'general.file_type',
      type: GgufType.UINT32,
      write: (b) => b.writeU32(15), // Q4_K_M
    },
    {
      key: 'llama.context_length',
      type: GgufType.UINT32,
      write: (b) => b.writeU32(8192),
    },
    {
      key: 'llama.embedding_length',
      type: GgufType.UINT32,
      write: (b) => b.writeU32(4096),
    },
    {
      key: 'llama.block_count',
      type: GgufType.UINT32,
      write: (b) => b.writeU32(32),
    },
    {
      key: 'llama.attention.head_count',
      type: GgufType.UINT32,
      write: (b) => b.writeU32(32),
    },
  ];

  const writer = new BufferWriter();
  writer.writeU32(0x46554747); // 'GGUF' LE
  writer.writeU32(3); // version
  writer.writeU64(0); // tensor_count
  writer.writeU64(BigInt(kvs.length));
  for (const kv of kvs) {
    writer.writeGgufString(kv.key);
    writer.writeU32(kv.type);
    kv.write(writer);
  }
  return writer.toArrayBuffer();
}

class BufferWriter {
  private chunks: Uint8Array[] = [];

  writeU32(v: number): void {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v, true);
    this.chunks.push(b);
  }

  writeU64(v: number | bigint): void {
    const b = new Uint8Array(8);
    const dv = new DataView(b.buffer);
    const big = typeof v === 'bigint' ? v : BigInt(v);
    dv.setUint32(0, Number(big & 0xffffffffn), true);
    dv.setUint32(4, Number((big >> 32n) & 0xffffffffn), true);
    this.chunks.push(b);
  }

  writeGgufString(s: string): void {
    const bytes = utf8(s);
    this.writeU64(bytes.length);
    this.chunks.push(bytes);
  }

  writeBytes(b: Uint8Array): void {
    this.chunks.push(b);
  }

  toArrayBuffer(): ArrayBuffer {
    let total = 0;
    for (const c of this.chunks) total += c.byteLength;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const c of this.chunks) {
      out.set(c, pos);
      pos += c.byteLength;
    }
    return out.buffer.slice(0, total);
  }
}

// ----- Safetensors synthetic builder ----------------------------------------

function buildSafetensorsBuffer(): ArrayBuffer {
  const header = {
    'model.embed_tokens.weight': {
      dtype: 'F16',
      shape: [128256, 4096],
      data_offsets: [0, 128256 * 4096 * 2],
    },
    'model.layers.0.self_attn.q_proj.weight': {
      dtype: 'F16',
      shape: [4096, 4096],
      data_offsets: [0, 4096 * 4096 * 2],
    },
    'lm_head.weight': {
      dtype: 'F16',
      shape: [128256, 4096],
      data_offsets: [0, 128256 * 4096 * 2],
    },
    __metadata__: {
      'modelspec.architecture': 'llama',
      'modelspec.title': 'Test Llama 8B',
      'modelspec.author': 'tester',
    },
  };
  const json = JSON.stringify(header);
  const jsonBytes = utf8(json);
  const out = new Uint8Array(8 + jsonBytes.byteLength);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, jsonBytes.byteLength, true);
  dv.setUint32(4, 0, true);
  out.set(jsonBytes, 8);
  return out.buffer;
}

function buildLoraSafetensorsBuffer(): ArrayBuffer {
  const header = {
    'base_model.model.layers.0.self_attn.q_proj.lora_A.weight': {
      dtype: 'F16',
      shape: [16, 4096],
      data_offsets: [0, 16 * 4096 * 2],
    },
    'base_model.model.layers.0.self_attn.q_proj.lora_B.weight': {
      dtype: 'F16',
      shape: [4096, 16],
      data_offsets: [0, 4096 * 16 * 2],
    },
  };
  const json = JSON.stringify(header);
  const jsonBytes = utf8(json);
  const out = new Uint8Array(8 + jsonBytes.byteLength);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, jsonBytes.byteLength, true);
  dv.setUint32(4, 0, true);
  out.set(jsonBytes, 8);
  return out.buffer;
}

// ----- Assertions -----------------------------------------------------------

let failed = 0;
function expect(cond: unknown, msg: string): void {
  if (!cond) {
    console.log('  FAIL:', msg);
    failed += 1;
  } else {
    console.log('  ok:  ', msg);
  }
}

// ----- Run synthetic tests ---------------------------------------------------

console.log('--- Synthetic GGUF parse ---');
{
  const buf = buildGgufBuffer();
  const meta = parseGgufHeader(buf);
  expect(meta.format === 'gguf', 'format = gguf');
  expect(
    meta.architecture === 'llama',
    `architecture = llama (got: ${meta.architecture})`,
  );
  expect(meta.name === 'Test Llama Model', `name (got: ${meta.name})`);
  expect(meta.basename === 'TestLlama-8B', `basename (got: ${meta.basename})`);
  expect(meta.sizeLabel === '8B', `sizeLabel (got: ${meta.sizeLabel})`);
  expect(meta.paramCount === 8e9, `paramCount = 8e9 (got: ${meta.paramCount})`);
  expect(
    meta.quantization === 'Q4_K_M',
    `quantization (got: ${meta.quantization})`,
  );
  expect(meta.contextMax === 8192, `contextMax (got: ${meta.contextMax})`);
  expect(
    meta.embeddingDim === 4096,
    `embeddingDim (got: ${meta.embeddingDim})`,
  );
  expect(meta.blockCount === 32, `blockCount (got: ${meta.blockCount})`);
  expect(meta.headCount === 32, `headCount (got: ${meta.headCount})`);
  expect(meta.modality === 'text', `modality (got: ${meta.modality})`);
}

console.log('--- Synthetic safetensors LLM parse ---');
{
  const buf = buildSafetensorsBuffer();
  const meta = parseSafetensorsHeader(buf);
  expect(meta.format === 'safetensors', 'format = safetensors');
  expect(
    meta.architecture === 'llama',
    `architecture = llama (got: ${meta.architecture})`,
  );
  expect(meta.name === 'Test Llama 8B', `name (got: ${meta.name})`);
  expect(meta.author === 'tester', `author (got: ${meta.author})`);
  expect(
    meta.quantization === 'FP16',
    `quantization (got: ${meta.quantization})`,
  );
  expect(
    typeof meta.paramCount === 'number' && meta.paramCount > 0,
    `paramCount > 0 (got: ${meta.paramCount})`,
  );
  expect(meta.modality === 'text', `modality (got: ${meta.modality})`);
}

console.log('--- Synthetic safetensors LoRA parse ---');
{
  const buf = buildLoraSafetensorsBuffer();
  const meta = parseSafetensorsHeader(buf);
  expect(meta.format === 'safetensors', 'format = safetensors');
  expect(meta.isLora === true, `isLora = true (got: ${meta.isLora})`);
  expect(
    meta.architecture === 'lora',
    `architecture = lora (got: ${meta.architecture})`,
  );
}

console.log('--- Truncated GGUF (should warn, not throw) ---');
{
  const buf = buildGgufBuffer();
  const truncated = buf.slice(0, Math.floor(buf.byteLength / 2));
  const meta = parseGgufHeader(truncated);
  expect(
    Array.isArray(meta.warnings) && meta.warnings.length > 0,
    'has warnings',
  );
  expect(meta.format === 'gguf', 'format still detected');
}

console.log('--- Bad magic (should throw) ---');
{
  const bad = new Uint8Array(64).buffer;
  let threw = false;
  try {
    parseGgufHeader(bad);
  } catch {
    threw = true;
  }
  expect(threw, 'parseGgufHeader threw on bad magic');
}

console.log('--- Shard detection ---');
{
  const { detectShardInfo } = require('../src/renderer/modelhub/shard');
  const cases: Array<[string, { current: number; total: number } | undefined]> =
    [
      ['model-00001-of-00003.gguf', { current: 1, total: 3 }],
      ['Llama-3-70B-Q5_K_M-00001-of-00012.gguf', { current: 1, total: 12 }],
      [
        'Qwen3-Coder-Next-Ud-Q6_K_X-00002-of-00003.gguf',
        { current: 2, total: 3 },
      ],
      // Underscore separators (seen with several conversion tools)
      ['model_00001_of_00012.gguf', { current: 1, total: 12 }],
      ['model_00007_of_00012.gguf', { current: 7, total: 12 }],
      // Capitalized `Of`, mixed separators
      ['model-0001_Of_0010.gguf', { current: 1, total: 10 }],
      ['model_0005-OF-0010.gguf', { current: 5, total: 10 }],
      // 3-digit padding
      ['model-001-of-010.safetensors', { current: 1, total: 10 }],
      ['model.safetensors', undefined],
      ['Acestep-V15-Base-Q5_K_M.Q5_K_M.gguf', undefined],
    ];
  for (const [name, expected] of cases) {
    const got = detectShardInfo(name);
    expect(
      JSON.stringify(got) === JSON.stringify(expected),
      `${name} → ${JSON.stringify(got)} (expected ${JSON.stringify(expected)})`,
    );
  }
}

console.log(
  '--- Auto-tag size priority (sizeLabel > paramCount on shards) ---',
);
{
  // Shard 1/3 with sizeLabel "30B" — should report 30-70B (label wins)
  const tags1 = computeAutoTags({
    header: {
      format: 'gguf',
      architecture: 'qwen3',
      sizeLabel: '30B',
      paramCount: 30e9, // GGUF derives this from sizeLabel anyway
      shardInfo: { current: 1, total: 3 },
    },
  });
  expect(
    tags1.includes('tier:13-30B') || tags1.includes('tier:30-70B'),
    `bucket from 30B (got: ${tags1.join(', ')})`,
  );
  // Models Hub treats shards as one logical model — no shard:* tag emitted.
  expect(
    !tags1.some((t) => t.startsWith('shard:')),
    `shard:* not emitted on canonical (got: ${tags1.join(', ')})`,
  );

  // Shard 1/3 with no sizeLabel and small paramCount (partial sum) — no size tag
  const tags2 = computeAutoTags({
    header: {
      format: 'safetensors',
      architecture: 'llama',
      paramCount: 2e9, // partial — would wrongly bucket as 1-3B
      shardInfo: { current: 1, total: 3 },
    },
  });
  expect(
    !tags2.some((t) => t.startsWith('tier:')),
    `no tier:* on shard without sizeLabel (got: ${tags2.join(', ')})`,
  );
  expect(
    !tags2.some((t) => t.startsWith('shard:')),
    `no shard:* tag (got: ${tags2.join(', ')})`,
  );

  // Single file, paramCount only — should bucket
  const tags3 = computeAutoTags({
    header: { format: 'safetensors', architecture: 'llama', paramCount: 8e9 },
  });
  expect(
    tags3.includes('tier:7-13B'),
    `single-file size tag (got: ${tags3.join(', ')})`,
  );

  // Sharded with totalBytes set + Q5 quant: 60 GB ÷ 0.625 ≈ 96B params → 70B+
  const tags4 = computeAutoTags({
    header: {
      format: 'gguf',
      architecture: 'llama',
      quantization: 'Q5_K_M',
      shardInfo: { current: 1, total: 12 },
      totalBytes: 60_000_000_000,
      shardCount: 12,
    },
  });
  expect(
    tags4.includes('tier:70B+'),
    `size from totalBytes via Q5 multiplier (got: ${tags4.join(', ')})`,
  );

  // Sharded, no quant, totalBytes ~40 GB → assumes Q4 (0.5) → 80B → 70B+
  const tags5 = computeAutoTags({
    header: {
      format: 'gguf',
      architecture: 'llama',
      shardInfo: { current: 1, total: 8 },
      totalBytes: 40_000_000_000,
      shardCount: 8,
    },
  });
  expect(
    tags5.includes('tier:70B+'),
    `size from totalBytes default Q4 (got: ${tags5.join(', ')})`,
  );
}

console.log('--- HF heuristic ---');
{
  const stripped = stripQuantizationSuffixes('Llama-3-8B-Instruct-Q4_K_M.gguf');
  expect(
    stripped === 'Llama-3-8B-Instruct',
    `strip quantization (got: ${stripped})`,
  );

  const candidates1 = guessRepoCandidates(
    'D:/models/LLM/meta-llama/Llama-3-8B-Instruct/Llama-3-8B-Instruct-Q4_K_M.gguf',
  );
  expect(
    candidates1.some(
      (c) => c.repo === 'meta-llama/Llama-3-8B-Instruct' && c.source === 'path',
    ),
    `path heuristic finds meta-llama/Llama-3-8B-Instruct (got: ${candidates1.map((c) => c.repo).join(', ')})`,
  );

  const candidates2 = guessRepoCandidates(
    'D:/models/LLM/Acestep-5Hz-Lm-0.BF16.gguf',
    {
      format: 'gguf',
      basename: 'acestep-5Hz-lm-0.6B',
      architecture: 'acestep-lm',
    },
  );
  // No clean author segment → all candidates rejected by NON_AUTHOR_SEGMENTS
  expect(
    candidates2.length === 0,
    `no candidates when path lacks author (got: ${candidates2.map((c) => c.repo).join(', ')})`,
  );
}

console.log('--- Auto-tag derivation ---');
{
  const tags = computeAutoTags({
    header: {
      format: 'gguf',
      architecture: 'llama',
      quantization: 'Q4_K_M',
      paramCount: 8e9,
      modality: 'text',
    },
  });
  expect(tags.includes('arch:llama'), `arch:llama (got: ${tags.join(', ')})`);
  expect(tags.includes('quant:q4_k_m'), 'quant:q4_k_m');
  expect(tags.includes('tier:7-13B'), `tier:7-13B (got: ${tags.join(', ')})`);
  expect(tags.includes('mod:text'), 'mod:text');
  expect(tags.includes('fmt:gguf'), 'fmt:gguf');

  const loraTags = computeAutoTags({
    header: {
      format: 'safetensors',
      architecture: 'lora',
      isLora: true,
    },
  });
  expect(
    loraTags.includes('type:lora'),
    `type:lora (got: ${loraTags.join(', ')})`,
  );

  const hfTags = computeAutoTags({
    header: { format: 'gguf', architecture: 'mistral' },
    huggingface: {
      repo: 'x/y',
      license: 'apache-2.0',
      pipelineTag: 'text-generation',
    },
  });
  expect(
    hfTags.includes('lic:apache-2'),
    `lic:apache-2 (got: ${hfTags.join(', ')})`,
  );
  expect(hfTags.includes('mod:text'), 'mod:text from HF pipelineTag');

  // File size is NOT tagged — it's filtered numerically via sizeMin/sizeMax
  // (see services/search.ts). Confirm we never emit gb:* tags.
  const sized = computeAutoTags({
    header: { format: 'gguf', fileSize: 4_700_000_000 },
  });
  expect(
    !sized.some((t) => t.startsWith('gb:')),
    `no gb:* tag (got: ${sized.join(', ')})`,
  );
}

console.log('--- MoE size_label parsing ---');
{
  // Mixtral-style "8x7B": 56B total → 30-70B.
  const mixtral = computeAutoTags({
    header: { format: 'gguf', architecture: 'mistral', sizeLabel: '8x7B' },
  });
  expect(
    mixtral.includes('tier:30-70B'),
    `mixtral 8x7B → tier:30-70B (got: ${mixtral.join(', ')})`,
  );

  // GLM-5.1 "256x22B": 5.6T total → 70B+. Regression for the <1B mis-bucket.
  const glm = computeAutoTags({
    header: { format: 'gguf', architecture: 'llama', sizeLabel: '256x22B' },
  });
  expect(
    glm.includes('tier:70B+'),
    `glm 256x22B → tier:70B+ (got: ${glm.join(', ')})`,
  );

  // Dense control: "8B" still buckets to 7-13B (no MoE multiplication).
  const dense = computeAutoTags({
    header: { format: 'gguf', architecture: 'llama', sizeLabel: '8B' },
  });
  expect(
    dense.includes('tier:7-13B'),
    `dense 8B → tier:7-13B (got: ${dense.join(', ')})`,
  );
}

console.log('--- Folder segment auto-tags ---');
{
  // Each path segment between rootDir and the file should become a `dir:` tag,
  // lower-cased and dash-sanitized.
  const dirTags = computeAutoTags({
    header: { format: 'gguf', architecture: 'llama' },
    folderSegments: ['LLM', 'Codage', 'Qwen3-Coder'],
  });
  expect(dirTags.includes('dir:llm'), `dir:llm (got: ${dirTags.join(', ')})`);
  expect(dirTags.includes('dir:codage'), 'dir:codage');
  expect(dirTags.includes('dir:qwen3-coder'), 'dir:qwen3-coder');

  // Blocklisted segments (generic collection roots) are dropped.
  const noiseDropped = computeAutoTags({
    header: { format: 'gguf' },
    folderSegments: ['models', 'LLM'],
  });
  expect(
    noiseDropped.includes('dir:llm') && !noiseDropped.includes('dir:models'),
    `models/ blocklisted (got: ${noiseDropped.join(', ')})`,
  );

  // Whitespace + spaces collapse cleanly.
  const spaced = computeAutoTags({
    header: { format: 'gguf' },
    folderSegments: ['My Models', '  Image  Generation  '],
  });
  expect(
    spaced.includes('dir:my-models'),
    `whitespace -> dash (got: ${spaced.join(', ')})`,
  );
  expect(spaced.includes('dir:image-generation'), 'collapsed spaces');

  // Segments-empty case must not emit any dir:* tags.
  const noFolders = computeAutoTags({ header: { format: 'gguf' } });
  expect(
    !noFolders.some((t) => t.startsWith('dir:')),
    `no dir:* without folderSegments (got: ${noFolders.join(', ')})`,
  );
}

console.log('--- computeFolderSegments helper ---');
{
  const { computeFolderSegments } = require('../src/main/modelhub/folderTags');
  // With rootDir: full chain
  const segs1 = computeFolderSegments(
    'D:/models/LLM/Codage/Qwen3-Coder.gguf',
    'D:/models',
  );
  expect(
    JSON.stringify(segs1) === JSON.stringify(['LLM', 'Codage']),
    `with rootDir (got: ${JSON.stringify(segs1)})`,
  );
  // Without rootDir: parent only
  const segs2 = computeFolderSegments('D:/models/LLM/Codage/Qwen3-Coder.gguf');
  expect(
    JSON.stringify(segs2) === JSON.stringify(['Codage']),
    `without rootDir (got: ${JSON.stringify(segs2)})`,
  );
  // Outside rootDir: fall back to parent
  const segs3 = computeFolderSegments('D:/elsewhere/x.gguf', 'D:/models');
  expect(
    JSON.stringify(segs3) === JSON.stringify(['elsewhere']),
    `outside rootDir falls back (got: ${JSON.stringify(segs3)})`,
  );
}

console.log('--- paramBuckets filter via applyModelhubFilters ---');
{
  const {
    _testApplyModelhubFilters,
  } = require('../src/renderer/services/search');

  const mkEntry = (name: string, tagTitles: string[]) => ({
    name,
    path: `/x/${name}`,
    isFile: true,
    size: 5_000_000_000,
    tags: tagTitles.map((t) => ({ title: t })),
  });

  const small = mkEntry('llama-3b.gguf', ['tier:1-3B']);
  const mid = mkEntry('llama-13b.gguf', ['tier:7-13B']);
  const big = mkEntry('llama-70b.gguf', ['tier:30-70B']);
  const untagged = mkEntry('mystery.gguf', []);
  const set = [small, mid, big, untagged];

  // No buckets active → all model files pass (untagged still pass — only
  // bucket filter requires tags).
  const all = _testApplyModelhubFilters(set, {});
  expect(all.length === 4, `no-filter passes all (got: ${all.length})`);

  // Single bucket selected → drops other buckets + untagged
  const seven = _testApplyModelhubFilters(set, { paramBuckets: ['7-13B'] });
  expect(seven.length === 1, `7-13B alone returns 1 (got: ${seven.length})`);
  expect(seven[0].name === 'llama-13b.gguf', `kept the 13B model`);

  // Multi-bucket OR
  const midOrBig = _testApplyModelhubFilters(set, {
    paramBuckets: ['7-13B', '30-70B'],
  });
  expect(
    midOrBig.length === 2,
    `multi-bucket OR returns 2 (got: ${midOrBig.length})`,
  );
  expect(
    midOrBig.some((e: { name: string }) => e.name === 'llama-13b.gguf') &&
      midOrBig.some((e: { name: string }) => e.name === 'llama-70b.gguf'),
    'both 13B and 70B kept',
  );

  // Untagged entries are dropped when buckets are active (avoid false positives).
  const onlyTagged = _testApplyModelhubFilters(set, {
    paramBuckets: ['<1B'],
  });
  expect(
    onlyTagged.length === 0,
    `<1B alone returns 0 here (untagged dropped) (got: ${onlyTagged.length})`,
  );

  // Combine with size filter — 70B model wins on params but a strict
  // sizeMax should still drop it.
  const big100 = mkEntry('big.gguf', ['tier:30-70B']);
  big100.size = 100_000_000_000;
  const small5 = mkEntry('small.gguf', ['tier:30-70B']);
  small5.size = 5_000_000_000;
  const combo = _testApplyModelhubFilters([big100, small5], {
    paramBuckets: ['30-70B'],
    sizeMax: 50_000_000_000,
  });
  expect(
    combo.length === 1 && combo[0].name === 'small.gguf',
    'AND across filters',
  );
}

// ----- Optional real-file probe ---------------------------------------------

const probeFolder = process.argv[2];
if (probeFolder && fs.existsSync(probeFolder)) {
  console.log(`--- Real-file probe in ${probeFolder} ---`);
  const found: { gguf?: string; safetensors?: string } = {};
  function walk(dir: string, depth = 0): void {
    if (depth > 4) return;
    if (found.gguf && found.safetensors) return;
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const p = path.join(dir, name);
      let st;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(p, depth + 1);
        if (found.gguf && found.safetensors) return;
      } else if (st.isFile()) {
        if (!found.gguf && name.toLowerCase().endsWith('.gguf')) found.gguf = p;
        if (!found.safetensors && name.toLowerCase().endsWith('.safetensors'))
          found.safetensors = p;
      }
    }
  }
  walk(probeFolder);

  for (const [fmt, file] of Object.entries(found) as Array<
    ['gguf' | 'safetensors', string]
  >) {
    if (!file) continue;
    console.log(`  probing ${fmt}: ${file}`);
    const fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd);
    const wanted =
      fmt === 'gguf' ? 1024 * 1024 : Math.min(16 * 1024 * 1024, stat.size);
    const buf = Buffer.alloc(wanted);
    fs.readSync(fd, buf as unknown as NodeJS.ArrayBufferView, 0, wanted, 0);
    fs.closeSync(fd);
    const ab = (buf.buffer as ArrayBuffer).slice(
      buf.byteOffset,
      buf.byteOffset + wanted,
    );
    try {
      const meta =
        fmt === 'gguf' ? parseGgufHeader(ab) : parseSafetensorsHeader(ab);
      console.log(
        '    ',
        JSON.stringify({ ...meta, rawMetadata: '<omitted>' }, null, 2),
      );
    } catch (e) {
      console.log('     parse failed:', (e as Error).message);
    }
  }
  if (!found.gguf && !found.safetensors) {
    console.log('  no .gguf or .safetensors found in folder');
  }

  // ----- End-to-end enrichLocal + optional enrichHf ----------------------
  const writeFlag = process.argv.includes('--persist');
  const networkFlag = process.argv.includes('--network');
  const candidate = found.gguf ?? found.safetensors;
  if (candidate) {
    (async () => {
      console.log(
        `\n--- enrichLocal on ${candidate} (skipWrite=${!writeFlag}) ---`,
      );
      const localRes = await enrichLocal(candidate, { skipWrite: !writeFlag });
      console.log('   ok:', localRes.ok);
      console.log('   sidecarPath:', localRes.sidecarPath);
      console.log('   written:', localRes.written);
      console.log('   autoTags:', localRes.autoTags);
      if (localRes.modelMeta?.header) {
        const { rawMetadata, ...trimmed } = localRes.modelMeta.header;
        console.log('   header (trimmed):', JSON.stringify(trimmed, null, 2));
      }

      // ----- Bulk enrichment (skipWrite, capped) -----
      console.log(
        `\n--- listModelFiles + enrichFolder on ${probeFolder} (skipWrite, maxFiles=5) ---`,
      );
      const fileList = await listModelFiles(probeFolder, { maxFiles: 5 });
      console.log(`   found ${fileList.length} model file(s) (cap 5)`);
      let progressCount = 0;
      const bulkSummary = await enrichFolder(
        probeFolder,
        { mode: 'local', skipWrite: true, maxFiles: 5, concurrency: 2 },
        (p) => {
          progressCount += 1;
          if (p.processed > 0 && p.processed % 1 === 0) {
            const fname = p.currentFile?.replace(/^.*[\\/]/, '');
            console.log(
              `   [${p.processed}/${p.total}] ${p.lastStatus} — ${fname ?? ''}` +
                (p.lastAutoTags ? ` tags=[${p.lastAutoTags.join(', ')}]` : ''),
            );
          }
        },
      );
      console.log(
        `   summary: ok=${bulkSummary.ok} skipped=${bulkSummary.skipped} errors=${bulkSummary.errors} processed=${bulkSummary.processed}/${bulkSummary.total}`,
      );
      expect(
        bulkSummary.processed === bulkSummary.total,
        `processed (${bulkSummary.processed}) === total (${bulkSummary.total})`,
      );
      expect(
        progressCount >= bulkSummary.total,
        'progress events fired for each file',
      );

      if (networkFlag) {
        // Use a known small public repo to verify the HF pipeline end-to-end
        // without depending on the user's local files matching HF.
        const REPO = 'TinyLlama/TinyLlama-1.1B-Chat-v1.0';
        console.log(
          `\n--- enrichHf with manual candidate ${REPO} (skipWrite=true) ---`,
        );
        try {
          const hfRes = await enrichHf(candidate, {
            skipWrite: true,
            candidates: [{ repo: REPO, source: 'path', confidence: 'high' }],
          });
          console.log('   ok:', hfRes.ok);
          console.log('   matchedRepo:', hfRes.matchedRepo);
          console.log('   autoTags:', hfRes.autoTags);
          if (hfRes.modelMeta?.huggingface) {
            const { descriptionEN, ...summary } = hfRes.modelMeta.huggingface;
            console.log('   hf:', JSON.stringify(summary, null, 2));
            if (descriptionEN) {
              console.log(
                '   description (first 200 chars):',
                descriptionEN.slice(0, 200).replace(/\n/g, ' '),
              );
            }
          }
          if (!hfRes.ok) {
            console.log('   error:', hfRes.error);
          }
        } catch (e) {
          console.log('   enrichHf threw:', (e as Error).message);
        }
      }

      finalReport();
    })().catch((e) => {
      console.log('   smoke async failed:', (e as Error).message);
      process.exit(1);
    });
  } else {
    finalReport();
  }
} else {
  finalReport();
}

function finalReport(): void {
  if (failed > 0) {
    console.log(`\n${failed} assertions failed`);
    process.exit(1);
  }
  console.log('\nAll assertions passed.');
}
