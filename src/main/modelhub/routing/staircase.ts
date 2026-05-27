// Slice 4a + étape-1 — staircase characterization engine (SPEC §3, pure core).
//
// Per leaf we climb the difficulty ladder until the FIRST failure
// (early-stop, CAT-style). The leaf score is now the **Beta-Laplace
// posterior mean** `(1 + passes) / (2 + asked)` over the climb (étape 1
// 2026-05) — NOT the breaking rung. Why: integer rungs saturate at the
// ladder top (3/3 ⇒ 1.0) and pretend perfect competence; Laplace
// smoothing keeps 3/3 at 0.80 (= 4/5), and only Phase B (more items)
// lifts that toward 1. `safety` stays binary 0/1 (single item, no
// smoothing). A branch is only "opened" (leaves climbed past level 1)
// if the cheap level-1 probe meets θ_open — this auto-bounds cost. The
// open/close gate uses the RAW level-1 pass fraction (not Laplace-
// smoothed) because it's a routing-path decision, not a competence.
// Deterministic: model I/O is the injected `ChatLike` seam, scoring is
// slice-2b `runCheck`. `code-tests` rungs need the slice-2d sandbox and
// `runtime_inject` rungs need the asset pipeline; absent their seam the
// rung is UNMEASURED (≠ failed) so it becomes a branch prior at
// routing (D12), never a false zero.

import type { DiagnosticPrompt } from '../../../shared/RoutingTypes';
import type { ChatLike } from './chat';
import { runCheck, isSandboxRequest } from './scorers/checkSpec';
import { getScorer } from './scorers';

/** SPEC §3 default — open a branch's leaves only if level-1 ≥ this. */
export const DEFAULT_THETA_OPEN = 0.6;

export type Unmeasured = 'sandbox-pending' | 'runtime-inject' | 'no-items';

/** Optional capabilities; absent ⇒ the dependent rung is unmeasured. */
export type StaircaseSeams = {
  /**
   * Slice-2d: execute the model's generated code plus the curated
   * `tests` (assert block) inside an isolated sandbox. Returns `true`
   * iff every assert passes; `false` iff any fails or the child exits
   * non-zero / times out / overflows output; THROWS iff the OS-level
   * boundary couldn't be established at all (the caller maps that to
   * UNMEASURED, never a false pass). `code` is the raw model response
   * (the `def solve(...)` it was prompted to emit).
   */
  runSandbox?: (req: {
    codeLang: 'python' | 'cpp';
    code: string;
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
  /**
   * scores_per_leaf for opened leaves: Beta-Laplace posterior mean
   * `(1 + passes_per_leaf[l]) / (2 + n_per_leaf[l])` ∈ (0, 1) — except
   * `safety` which stays binary 0/1.
   */
  scores_per_leaf: Record<string, number>;
  /** Items actually evaluated per leaf (audit / confidence). */
  n_per_leaf: Record<string, number>;
  /** Items PASSED per leaf (audit + Phase-B saturation trigger). */
  passes_per_leaf: Record<string, number>;
  /** Leaves left unmeasured and why (→ branch prior, D12). */
  unmeasured: Record<string, Unmeasured>;
};

/**
 * Beta-Laplace posterior mean `(1 + passes) / (2 + asked)`. Smooth: a
 * single 1/1 → 0.67 (not 1.0); a 3/3 → 0.80. Exported for tests and so
 * downstream code can recompute when Phase B adds items.
 */
export function betaLaplace(passes: number, asked: number): number {
  return (1 + passes) / (2 + asked);
}

/** Run one item through the model + slice-2b checker. Never throws. */
export async function evaluateItem(
  item: DiagnosticPrompt,
  ask: ChatLike,
  seams: StaircaseSeams = {},
  signal?: AbortSignal,
): Promise<ItemVerdict> {
  // Slice 7b: prompts can route to a registered DeterministicScorer by
  // id (rich multi-criterion, like the 6e/6f tooluse/robustness/...
  // scorers reused at L2 of the tools tree branch). If neither a
  // `check` block nor a scorer is registered, the item is genuinely
  // unmeasurable.
  const registeredScorer = getScorer(item.id);
  if (!item.check && !registeredScorer)
    return { status: 'unmeasured', reason: 'no-items' };
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
    response = await ask.complete(prompt, { id: item.id, signal });
  } catch (e) {
    // Bulk-cancel takes precedence: re-throw so the outer loop bails
    // out instead of recording every remaining item as `fail`.
    if (signal?.aborted) throw e;
    return { status: 'fail', reason: 'model-error' };
  }
  // Registered scorer first (covers `check: null` rich-rubric prompts).
  if (registeredScorer) {
    try {
      const sr = registeredScorer(response, item);
      return { status: sr.pass ? 'pass' : 'fail' };
    } catch {
      return { status: 'fail', reason: 'scorer-error' };
    }
  }
  const r = runCheck(item.check!, response);
  if (isSandboxRequest(r)) {
    if (!seams.runSandbox)
      return { status: 'unmeasured', reason: 'sandbox-pending' };
    try {
      const ok = await seams.runSandbox({
        codeLang: r.codeLang,
        code: response,
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
    /** Bulk-cancel propagation — forwarded to every evaluateItem call. */
    signal?: AbortSignal;
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

  // Final leaf score: binary safety (0/1) OR Beta-Laplace smoothed.
  const leafScore = (passes: number, ran: number): number =>
    binary ? (passes > 0 ? 1 : 0) : betaLaplace(passes, ran);

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
        passes_per_leaf: {},
        unmeasured: {},
      };
    const sl: Record<string, number> = {};
    const npl: Record<string, number> = {};
    const ppl: Record<string, number> = {};
    const um: Record<string, Unmeasured> = {};
    for (const leaf of leaves) {
      const items = sorted[leaf];
      if (!items.length) {
        um[leaf] = 'no-items';
        continue;
      }
      let ran = 0;
      let passes = 0;
      for (let i = 0; i < items.length; i++) {
        const v = await evaluateItem(items[i], ask, seams, opts.signal);
        if (v.status === 'unmeasured') {
          if (ran === 0) um[leaf] = (v.reason as Unmeasured) ?? 'no-items';
          break; // stop climb; keep last passed rung
        }
        ran++;
        if (v.status === 'pass') {
          passes++;
          if (binary) break; // safety = level-1 only
        } else break; // first failure → climb stops (Beta over what ran)
      }
      if (ran > 0) {
        sl[leaf] = leafScore(passes, ran);
        npl[leaf] = ran;
        ppl[leaf] = passes;
      }
    }
    return {
      branch,
      branch_score: gate,
      opened: true,
      scores_per_leaf: sl,
      n_per_leaf: npl,
      passes_per_leaf: ppl,
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
    const v = await evaluateItem(first, ask, seams, opts.signal);
    l1[leaf] = v;
    if (v.status === 'unmeasured') {
      unmeasured[leaf] = (v.reason as Unmeasured) ?? 'no-items';
      continue;
    }
    measurable++;
    if (v.status === 'pass') passed++;
  }

  // RAW pass fraction at L1 — kept un-smoothed: this is a gate decision
  // ("is this branch worth deepening?"), not a competence to compare
  // across models. Smoothing would shift the θ_open cut-off arbitrarily.
  const branch_score = measurable > 0 ? passed / measurable : undefined;
  const opened = branch_score !== undefined && branch_score >= thetaOpen;

  const scores_per_leaf: Record<string, number> = {};
  const n_per_leaf: Record<string, number> = {};
  const passes_per_leaf: Record<string, number> = {};
  if (!opened)
    return {
      branch,
      branch_score,
      opened: false,
      scores_per_leaf,
      n_per_leaf,
      passes_per_leaf,
      unmeasured,
    };

  for (const leaf of leaves) {
    const v1 = l1[leaf];
    if (!v1 || v1.status === 'unmeasured') continue; // already in `unmeasured`
    let ran = 1;
    let passes = v1.status === 'pass' ? 1 : 0;
    if (v1.status === 'pass' && !binary) {
      for (let i = 1; i < sorted[leaf].length; i++) {
        const item = sorted[leaf][i];
        const v = await evaluateItem(item, ask, seams, opts.signal);
        if (v.status === 'unmeasured') break; // stop climb; keep last rung
        ran++;
        if (v.status === 'pass') passes++;
        else break; // first failure → climb stops (Beta over what ran)
      }
    }
    scores_per_leaf[leaf] = leafScore(passes, ran);
    n_per_leaf[leaf] = ran;
    passes_per_leaf[leaf] = passes;
  }

  return {
    branch,
    branch_score,
    opened: true,
    scores_per_leaf,
    n_per_leaf,
    passes_per_leaf,
    unmeasured,
  };
}
