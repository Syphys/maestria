// Slice 4a — staircase characterization engine (SPEC §3, pure core).
//
// Per leaf we climb the difficulty ladder until the FIRST failure
// (early-stop, CAT-style): the leaf score is the breaking rung — the
// highest contiguous level passed, NOT a saturated 0..1. A branch is
// only "opened" (its leaves climbed past level 1) if the cheap level-1
// probe meets θ_open — this auto-bounds cost (a weak / off-domain model
// stops almost immediately). Deterministic: model I/O is the injected
// `ChatLike` seam, scoring is slice-2b `runCheck`. `code-tests` rungs
// need the slice-2d sandbox and `runtime_inject` rungs need the asset
// pipeline; absent their seam the rung is UNMEASURED (≠ failed) so it
// becomes a branch prior at routing (D12), never a false zero.

import type { DiagnosticPrompt } from '../../../shared/RoutingTypes';
import type { ChatLike } from './chat';
import { runCheck, isSandboxRequest } from './scorers/checkSpec';

/** SPEC §3 default — open a branch's leaves only if level-1 ≥ this. */
export const DEFAULT_THETA_OPEN = 0.6;

export type Unmeasured = 'sandbox-pending' | 'runtime-inject' | 'no-items';

/** Optional capabilities; absent ⇒ the dependent rung is unmeasured. */
export type StaircaseSeams = {
  /** Slice-2d: execute code-tests, return whether all asserts pass. */
  runSandbox?: (req: {
    codeLang: 'python' | 'cpp';
    tests: string;
  }) => Promise<boolean>;
  /** Asset pipeline: realise a runtime_inject prompt (needle/long text). */
  injectRuntime?: (prompt: string, inject: unknown) => Promise<string>;
};

export type ItemVerdict = {
  status: 'pass' | 'fail' | 'unmeasured';
  reason?: Unmeasured | string;
};

export type BranchMeasure = {
  branch: string;
  /** Fraction of MEASURABLE level-1 items passed; undefined ⇒ none measurable. */
  branch_score?: number;
  opened: boolean;
  /** scores_per_leaf for opened leaves: breaking rung (highest level passed). */
  scores_per_leaf: Record<string, number>;
  /** Items actually evaluated per leaf (audit / confidence). */
  n_per_leaf: Record<string, number>;
  /** Leaves left unmeasured and why (→ branch prior, D12). */
  unmeasured: Record<string, Unmeasured>;
};

/** Run one item through the model + slice-2b checker. Never throws. */
export async function evaluateItem(
  item: DiagnosticPrompt,
  ask: ChatLike,
  seams: StaircaseSeams = {},
): Promise<ItemVerdict> {
  if (!item.check) return { status: 'unmeasured', reason: 'no-items' };
  let prompt = item.prompt;
  if (item.runtime_inject) {
    if (!seams.injectRuntime)
      return { status: 'unmeasured', reason: 'runtime-inject' };
    try {
      prompt = await seams.injectRuntime(item.prompt, item.runtime_inject);
    } catch {
      return { status: 'unmeasured', reason: 'runtime-inject' };
    }
  }
  let response: string;
  try {
    response = await ask.complete(prompt, { id: item.id });
  } catch {
    return { status: 'fail', reason: 'model-error' };
  }
  const r = runCheck(item.check, response);
  if (isSandboxRequest(r)) {
    if (!seams.runSandbox)
      return { status: 'unmeasured', reason: 'sandbox-pending' };
    try {
      const ok = await seams.runSandbox({
        codeLang: r.codeLang,
        tests: r.tests,
      });
      return { status: ok ? 'pass' : 'fail' };
    } catch {
      return { status: 'unmeasured', reason: 'sandbox-pending' };
    }
  }
  return { status: r.pass ? 'pass' : 'fail' };
}

/**
 * Characterize ONE branch. `itemsByLeaf` maps each leaf to its ladder
 * items (any order; sorted here by `level`). Phase 1 probes level 1 of
 * every leaf and computes `branch_score` over the measurable ones; if it
 * is `≥ θ_open` the branch is opened and each leaf is climbed from
 * level 2 with early-stop. Closed branches leave leaves unmeasured (the
 * router falls back to the branch prior, D12). `safety` leaves are
 * binary (level-1 only, never laddered).
 */
export async function characterizeBranch(
  branch: string,
  itemsByLeaf: Record<string, DiagnosticPrompt[]>,
  ask: ChatLike,
  opts: {
    thetaOpen?: number;
    seams?: StaircaseSeams;
    /**
     * Slice 6a — R5-gated mode. When set, the open decision and the
     * persisted `branch_score` come from this INJECTED score (the
     * R5-mapped axis competence), NOT a self level-1 probe: we only
     * deepen branches R5 already says the model is strong at. Closed
     * (`< θ_open`) ⇒ ZERO model calls for this branch. Absent ⇒ the
     * legacy self-probe path (back-compat, unchanged).
     */
    branchGate?: number;
  } = {},
): Promise<BranchMeasure> {
  const thetaOpen = opts.thetaOpen ?? DEFAULT_THETA_OPEN;
  const seams = opts.seams ?? {};
  const binary = branch === 'safety';

  const leaves = Object.keys(itemsByLeaf);
  const sorted: Record<string, DiagnosticPrompt[]> = {};
  for (const leaf of leaves)
    sorted[leaf] = [...itemsByLeaf[leaf]].sort(
      (a, b) => (a.level ?? 1) - (b.level ?? 1),
    );

  // --- Slice 6a: R5-gated path (additive; legacy self-probe untouched).
  if (opts.branchGate !== undefined) {
    const gate = opts.branchGate;
    if (gate < thetaOpen)
      return {
        branch,
        branch_score: gate,
        opened: false,
        scores_per_leaf: {},
        n_per_leaf: {},
        unmeasured: {},
      };
    const sl: Record<string, number> = {};
    const npl: Record<string, number> = {};
    const um: Record<string, Unmeasured> = {};
    for (const leaf of leaves) {
      const items = sorted[leaf];
      if (!items.length) {
        um[leaf] = 'no-items';
        continue;
      }
      let ran = 0;
      let score = 0;
      for (let i = 0; i < items.length; i++) {
        const v = await evaluateItem(items[i], ask, seams);
        if (v.status === 'unmeasured') {
          if (ran === 0) um[leaf] = (v.reason as Unmeasured) ?? 'no-items';
          break; // stop climb; keep last passed rung
        }
        ran++;
        if (v.status === 'pass') {
          score = items[i].level ?? i + 1;
          if (binary) break; // safety = level-1 only
        } else break; // first failure → breaking rung reached
      }
      if (ran > 0) {
        sl[leaf] = score;
        npl[leaf] = ran;
      }
    }
    return {
      branch,
      branch_score: gate,
      opened: true,
      scores_per_leaf: sl,
      n_per_leaf: npl,
      unmeasured: um,
    };
  }

  const unmeasured: Record<string, Unmeasured> = {};
  const l1: Record<string, ItemVerdict> = {};
  let measurable = 0;
  let passed = 0;

  for (const leaf of leaves) {
    const first = sorted[leaf][0];
    if (!first) {
      unmeasured[leaf] = 'no-items';
      continue;
    }
    const v = await evaluateItem(first, ask, seams);
    l1[leaf] = v;
    if (v.status === 'unmeasured') {
      unmeasured[leaf] = (v.reason as Unmeasured) ?? 'no-items';
      continue;
    }
    measurable++;
    if (v.status === 'pass') passed++;
  }

  const branch_score = measurable > 0 ? passed / measurable : undefined;
  const opened = branch_score !== undefined && branch_score >= thetaOpen;

  const scores_per_leaf: Record<string, number> = {};
  const n_per_leaf: Record<string, number> = {};
  if (!opened)
    return {
      branch,
      branch_score,
      opened: false,
      scores_per_leaf,
      n_per_leaf,
      unmeasured,
    };

  for (const leaf of leaves) {
    const v1 = l1[leaf];
    if (!v1 || v1.status === 'unmeasured') continue; // already in `unmeasured`
    let ran = 1;
    let score = v1.status === 'pass' ? (sorted[leaf][0].level ?? 1) : 0;
    if (v1.status === 'pass' && !binary) {
      for (let i = 1; i < sorted[leaf].length; i++) {
        const item = sorted[leaf][i];
        const v = await evaluateItem(item, ask, seams);
        if (v.status === 'unmeasured') break; // stop climb; keep last rung
        ran++;
        if (v.status === 'pass') score = item.level ?? i + 1;
        else break; // first failure → breaking rung reached
      }
    }
    scores_per_leaf[leaf] = score;
    n_per_leaf[leaf] = ran;
  }

  return {
    branch,
    branch_score,
    opened: true,
    scores_per_leaf,
    n_per_leaf,
    unmeasured,
  };
}
