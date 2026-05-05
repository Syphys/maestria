/**
 * Smoke tests for the shard helpers (pure + fs-backed).
 *
 * Run:
 *   npx ts-node --transpile-only scripts/modelhub-shards-smoke.ts
 *
 * Builds a tiny synthetic shard set in `os.tmpdir()` to exercise the
 * fs-backed resolvers without needing real GGUF files.
 */
/// <reference types="node" />

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  canonicalShardName,
  detectShardInfo,
  isCanonicalShard,
  siblingShardNames,
  stripShardSuffix,
} from '../src/renderer/modelhub/shard';
import {
  findExistingSiblingShards,
  resolveCanonicalShardPath,
  sumShardBytes,
} from '../src/main/modelhub/shardFs';
import { listModelFiles } from '../src/main/modelhub/listModelFiles';

let failed = 0;
function assert(cond: boolean, msg: string, info?: unknown): void {
  if (cond) {
    console.log(
      '  ok:  ',
      msg,
      info !== undefined ? `(${JSON.stringify(info)})` : '',
    );
  } else {
    failed += 1;
    console.error(
      '  FAIL:',
      msg,
      info !== undefined ? JSON.stringify(info) : '',
    );
  }
}

console.log('--- detectShardInfo (regression) ---');
{
  assert(
    JSON.stringify(detectShardInfo('foo-00001-of-00012.gguf')) ===
      JSON.stringify({ current: 1, total: 12 }),
    'detects 1-of-12',
  );
  assert(
    detectShardInfo('plain.gguf') === undefined,
    'undefined for non-sharded',
  );
}

console.log('--- isCanonicalShard ---');
{
  assert(isCanonicalShard('plain.gguf'), 'plain file is canonical');
  assert(isCanonicalShard('foo-00001-of-00012.gguf'), 'shard 1 is canonical');
  assert(
    !isCanonicalShard('foo-00007-of-00012.gguf'),
    'shard 7 is not canonical',
  );
  assert(
    !isCanonicalShard('foo-00012-of-00012.gguf'),
    'shard 12 is not canonical',
  );
}

console.log('--- canonicalShardName ---');
{
  assert(
    canonicalShardName('foo-00007-of-00012.gguf') === 'foo-00001-of-00012.gguf',
    'rewrites 7 → 1',
  );
  assert(
    canonicalShardName('foo-00001-of-00012.gguf') === 'foo-00001-of-00012.gguf',
    'idempotent on canonical',
  );
  assert(
    canonicalShardName('plain.gguf') === 'plain.gguf',
    'leaves non-sharded alone',
  );
  // Width preservation: 5-digit pattern stays 5-digit.
  assert(
    canonicalShardName('a-00042-of-00100.safetensors').startsWith('a-00001-'),
    'preserves zero-padding width',
  );
}

console.log('--- siblingShardNames ---');
{
  const sibs = siblingShardNames('foo-00001-of-00003.gguf');
  assert(sibs.length === 3, 'returns 3 entries', sibs.length);
  assert(sibs[0].includes('00001-of-00003'), 'first is shard 1', sibs[0]);
  assert(sibs[2].includes('00003-of-00003'), 'third is shard 3', sibs[2]);

  const single = siblingShardNames('plain.gguf');
  assert(
    single.length === 1 && single[0] === 'plain.gguf',
    'non-sharded → self',
  );
}

console.log('--- stripShardSuffix ---');
{
  assert(
    stripShardSuffix('Qwen3-Coder-Next-Q6_K_Xl-00001-of-00003.gguf') ===
      'Qwen3-Coder-Next-Q6_K_Xl.gguf',
    'strips dash-of-dash suffix on .gguf',
  );
  assert(
    stripShardSuffix('model_00007_of_00012.gguf') === 'model.gguf',
    'strips underscore-of-underscore variant',
  );
  assert(
    stripShardSuffix('model-0001_Of_0010.safetensors') === 'model.safetensors',
    'case-insensitive Of, mixed separators',
  );
  assert(
    stripShardSuffix('plain.gguf') === 'plain.gguf',
    'leaves non-sharded names untouched',
  );
  assert(
    stripShardSuffix('Qwen3-Coder-Next-Q6_K_Xl-00001-of-00003') ===
      'Qwen3-Coder-Next-Q6_K_Xl',
    'works on bare title (no extension)',
  );
}

// ----- fs-backed: build a temp shard set ------------------------------------

(async () => {
  console.log('--- fs-backed: build synthetic shard set ---');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'modelhub-shards-test-'));
  const total = 4;
  // Create shards with predictable sizes (1 KB, 2 KB, 3 KB, 4 KB) so we can
  // assert the sum without ambiguity.
  for (let i = 1; i <= total; i += 1) {
    const padded = i.toString().padStart(5, '0');
    const totalPad = total.toString().padStart(5, '0');
    const fname = `model-${padded}-of-${totalPad}.gguf`;
    await fs.writeFile(path.join(dir, fname), Buffer.alloc(i * 1024));
  }
  const shard1 = path.join(dir, 'model-00001-of-00004.gguf');
  const shard3 = path.join(dir, 'model-00003-of-00004.gguf');

  console.log('--- resolveCanonicalShardPath ---');
  assert(
    (await resolveCanonicalShardPath(shard3)) === shard1,
    'shard 3 → shard 1',
  );
  assert(
    (await resolveCanonicalShardPath(shard1)) === shard1,
    'shard 1 → shard 1 (idempotent)',
  );

  console.log('--- resolveCanonicalShardPath: missing canonical fallback ---');
  // Delete shard 1 to simulate a partial download; resolver should fall back
  // to the input path rather than redirect into nothing.
  await fs.rm(shard1);
  const fallback = await resolveCanonicalShardPath(shard3);
  assert(
    fallback === shard3,
    'falls back to input when shard 1 missing',
    fallback,
  );

  // Recreate shard 1 for the rest of the tests.
  await fs.writeFile(shard1, Buffer.alloc(1024));

  console.log('--- findExistingSiblingShards ---');
  const found = await findExistingSiblingShards(shard1);
  assert(found.length === 4, 'found all 4 shards', found.length);

  // Drop shard 2 to simulate incompleteness.
  const shard2 = path.join(dir, 'model-00002-of-00004.gguf');
  await fs.rm(shard2);
  const partial = await findExistingSiblingShards(shard1);
  assert(
    partial.length === 3,
    'reports only existing siblings',
    partial.length,
  );

  // Restore shard 2.
  await fs.writeFile(shard2, Buffer.alloc(2 * 1024));

  console.log('--- sumShardBytes ---');
  const agg = await sumShardBytes(shard1);
  // 1+2+3+4 KB
  assert(
    agg.totalBytes === (1 + 2 + 3 + 4) * 1024,
    'totalBytes sums to 10 KB',
    agg.totalBytes,
  );
  assert(agg.shardCount === 4, 'shardCount = 4', agg.shardCount);
  assert(agg.expectedTotal === 4, 'expectedTotal = 4', agg.expectedTotal);
  assert(!agg.incomplete, 'not incomplete', agg.incomplete);

  console.log('--- sumShardBytes: incomplete set ---');
  await fs.rm(shard2);
  const partialAgg = await sumShardBytes(shard1);
  assert(partialAgg.shardCount === 3, 'shardCount drops to 3');
  assert(partialAgg.incomplete, 'flagged incomplete');

  console.log('--- sumShardBytes: non-sharded plain file ---');
  const plain = path.join(dir, 'plain.gguf');
  await fs.writeFile(plain, Buffer.alloc(5 * 1024));
  const plainAgg = await sumShardBytes(plain);
  assert(plainAgg.totalBytes === 5 * 1024, 'plain file total = own size');
  assert(plainAgg.shardCount === 1, 'plain file shardCount = 1');
  assert(plainAgg.expectedTotal === undefined, 'plain has no expectedTotal');

  // Re-create shard 2 so all 4 are present for the listing test.
  await fs.writeFile(shard2, Buffer.alloc(2 * 1024));

  console.log('--- listModelFiles: skips non-canonical shards ---');
  const listed = await listModelFiles(dir);
  // Should contain: shard 1 (canonical) + plain.gguf. Not shards 2..4.
  assert(listed.length === 2, `2 entries returned (got: ${listed.length})`);
  assert(
    listed.some((p) => p.endsWith('model-00001-of-00004.gguf')),
    'shard 1 included',
  );
  assert(
    listed.some((p) => p.endsWith('plain.gguf')),
    'plain file included',
  );
  assert(
    !listed.some((p) => /-0000[234]-of-00004/.test(p)),
    `shards 2..4 excluded (got: ${listed.join(', ')})`,
  );

  // Cleanup
  await fs.rm(dir, { recursive: true, force: true });

  if (failed > 0) {
    console.error(`\n${failed} assertion(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll shard-helper assertions passed.');
})().catch((e) => {
  console.error('Test harness failed:', e);
  process.exit(1);
});
