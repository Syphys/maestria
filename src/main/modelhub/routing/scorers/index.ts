// Registry mapping promptId → deterministic scorer (R2.6).
// The characterization runner consults this map per prompt.
//
// To register a new scorer:
//   1. Write src/main/modelhub/routing/scorers/<promptId>.ts exporting `score`
//   2. Add an entry below
//
// No-judge policy (DECISIONS.md D3): there is NO LLM-judge fallback. A
// prompt without a deterministic scorer (and not an MCQ item) simply does
// not contribute to the deterministic competence vector.

import type { DeterministicScorer } from './_types';
import { score as mathAlgebra01 } from './math-algebra-01';
import { score as mathArith01 } from './math-arith-01';
import { score as mathProof01 } from './math-proof-01';
import { score as reasoningLogic01 } from './reasoning-logic-01';
import { score as reasoningCounter01 } from './reasoning-counter-01';
import { score as factualHistory01 } from './factual-history-01';
import { score as factualScience01 } from './factual-science-01';
import { score as longctxExtract01 } from './longctx-extract-01';
import { score as instructionFormat01 } from './instruction-format-01';
import { score as metaClassify01 } from './meta-classify-01';
import { score as tooluseCall01 } from './tooluse-call-01';
import { score as robustnessInject01 } from './robustness-inject-01';
import { score as calibrationAbstain01 } from './calibration-abstain-01';

export const DETERMINISTIC_SCORERS: Record<string, DeterministicScorer> = {
  'math-algebra-01': mathAlgebra01,
  'math-arith-01': mathArith01,
  'math-proof-01': mathProof01,
  'reasoning-logic-01': reasoningLogic01,
  'reasoning-counter-01': reasoningCounter01,
  'factual-history-01': factualHistory01,
  'factual-science-01': factualScience01,
  'longctx-extract-01': longctxExtract01,
  'instruction-format-01': instructionFormat01,
  'meta-classify-01': metaClassify01,
  'tooluse-call-01': tooluseCall01,
  'robustness-inject-01': robustnessInject01,
  'calibration-abstain-01': calibrationAbstain01,
};

export function getScorer(promptId: string): DeterministicScorer | null {
  return DETERMINISTIC_SCORERS[promptId] ?? null;
}

export function hasDeterministicScorer(promptId: string): boolean {
  return promptId in DETERMINISTIC_SCORERS;
}
