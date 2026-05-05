/**
 * Manual probe of enrichHf on a real file.
 * Run: npx ts-node --transpile-only scripts/modelhub-test-hf.ts <full-path-to-model>
 */
/// <reference types="node" />

import { enrichHf } from '../src/main/modelhub/enrichHf';
import { guessRepoCandidates } from '../src/main/modelhub/hfHeuristic';
import { searchModels } from '../src/main/modelhub/hfClient';

(async () => {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('usage: modelhub-test-hf.ts <full-path-to-model>');
    process.exit(1);
  }

  console.log('1. Heuristic candidates from path:');
  const heur = guessRepoCandidates(filePath);
  for (const c of heur) {
    console.log(`   - ${c.repo} (${c.source}, ${c.confidence})`);
  }
  if (heur.length === 0) {
    console.log('   <none>');
  }

  console.log('\n2. enrichHf with skipWrite=true...');
  const res = await enrichHf(filePath, { skipWrite: true });
  console.log('   ok:', res.ok);
  console.log('   matchedRepo:', res.matchedRepo);
  console.log(
    '   triedCandidates:',
    res.triedCandidates?.map((c) => `${c.repo}(${c.confidence})`).join(', '),
  );
  if (!res.ok) {
    console.log('   error:', res.error);
  } else if (res.modelMeta?.huggingface) {
    const hf = res.modelMeta.huggingface;
    console.log('   →', hf.repo);
    console.log('   downloads:', hf.downloads);
    console.log('   license:', hf.license);
    console.log('   pipelineTag:', hf.pipelineTag);
    console.log('   autoTags:', res.autoTags);
  }

  if (process.argv.includes('--also-search')) {
    const term = process.argv[3] ?? 'Qwen3-Coder';
    console.log(`\n3. Direct HF search for "${term}":`);
    const hits = await searchModels(term, { limit: 5 });
    for (const h of hits) {
      console.log(
        `   - ${h.id}  (downloads=${h.downloads ?? '?'}, pipeline=${h.pipeline_tag ?? '-'})`,
      );
    }
  }
})().catch((e) => {
  console.error('threw:', (e as Error).message);
  process.exit(1);
});
