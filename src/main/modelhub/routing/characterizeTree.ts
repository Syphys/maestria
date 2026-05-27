// Slice 4c — tree-v0 characterization orchestrator (SPEC §3/§5/§6/§6bis).
//
// Wires the slice-4a staircase (per branch, θ_open gate, breaking-rung
// scores) and the slice-4b QCM reliability (judge-candidacy + Dyy/D12
// dual-purpose leaf prior) into the model's Signature, then persists it
// via signatureStore (read-only honoured through `skipWrite`).
//
// Additive & non-destructive: the R5 behavioral fields (`diagnostic_run`,
// `scores_per_axis`) are preserved untouched — this only fills the v0
// vector-routing fields (`scores_per_leaf`, `branch_scores`,
// `n_per_leaf`, `qcm_reliability`). Structural is left to R0.4 /
// `characterize.ts` (we never recompute it; existing value preserved).
// Pure orchestration over injected seams ⇒ fully offline-testable.

import {
  COMPETENCE_TREE,
  type BehavioralSignature,
  type CompetenceBranch,
  type DiagnosticAxis,
  type DiagnosticPrompt,
  type Signature,
  type StructuralSignature,
} from '../../../shared/RoutingTypes';
import type { ChatLike } from './chat';
import { characterizeBranch, type StaircaseSeams } from './staircase';
import { measureQcmReliability } from './qcmReliability';
import type { EmbedFn } from './embedProject';
import { generateFreeGenText, projectFreeGenText } from './freegen';
import probeAnchors from './questions/probe-anchors.json';
import type { ProbeAnchorBank } from '../../../shared/RoutingTypes';
import {
  loadSignature,
  saveSignature,
  makePendingSignature,
} from './signatureStore';
import { computeModelHash } from './modelHash';
// Static imports so webpack inlines the packs (same rationale as
// characterize.ts — reading from __dirname breaks in the packaged app).
import treeV0 from './questions/tree-v0.json';
import qcmV0 from './questions/qcm-v0.json';

const STUB_STRUCTURAL: StructuralSignature = {
  architecture: 'unknown',
  params: { total_b: 0, active_b: null },
  quantization: 'unknown',
  modality: 'text',
  context_max: 0,
  est_footprint_bytes: 0,
};

/** Low-confidence weight of a QCM-derived leaf prior (D12, router default). */
export const DEFAULT_QCM_PRIOR_DISCOUNT = 0.5;

type Suite = { id: string; prompts: DiagnosticPrompt[] };

/**
 * Slice 6a — map the coarse R5 `scores_per_axis` onto the tree branches
 * so R5 decides which branches the staircase deepens (only the
 * R5-maximal ones; SPEC §3 gate, owner ratification 2026-05-18). A
 * branch is gated only when at least one source axis was measured;
 * absent ⇒ omitted ⇒ characterizeBranch falls back to its self-probe
 * for that branch (back-compat, no R5 data case).
 */
export function branchGateFromAxes(
  spa: Partial<Record<DiagnosticAxis, number>> | undefined,
): Partial<Record<CompetenceBranch, number>> {
  if (!spa) return {};
  const maxOf = (...axes: DiagnosticAxis[]): number | undefined => {
    const vals = axes
      .map((a) => spa[a])
      .filter((v): v is number => typeof v === 'number');
    return vals.length ? Math.max(...vals) : undefined;
  };
  const src: Record<CompetenceBranch, number | undefined> = {
    code: maxOf('code'),
    math: maxOf('math'),
    reasoning: maxOf('reasoning', 'multistep'),
    lang: maxOf('fr', 'en', 'zh'),
    format: maxOf('instruction'),
    longctx: maxOf('longctx'),
    safety: maxOf('refusal'),
    informatics: maxOf('informatics'),
    // Slice 7b — `tools` branch gate = max of its four R5 axes. Strong
    // on ANY tooluse/robustness/calibration/summarization is enough to
    // open the laddered climb (we'll see which leaf is the strong one).
    tools: maxOf('tooluse', 'robustness', 'calibration', 'summarization'),
  };
  const out: Partial<Record<CompetenceBranch, number>> = {};
  for (const [b, v] of Object.entries(src) as [
    CompetenceBranch,
    number | undefined,
  ][])
    if (v !== undefined) out[b] = v;
  return out;
}

export type CharacterizeTreeOptions = {
  modelFilePath: string;
  /** Live llama-server chat seam (real ChatClient in production). */
  ask: ChatLike;
  skipWrite?: boolean;
  thetaOpen?: number;
  qcmPriorDiscount?: number;
  seams?: StaircaseSeams;
  /**
   * Slice 6a — explicit per-branch R5 gate (tests / override). When
   * absent it is derived from the existing signature's
   * `scores_per_axis` (so a juxtaposed R5 pass auto-drives the tree).
   */
  branchGate?: Partial<Record<CompetenceBranch, number>>;
  /**
   * Slice 7c — Free-gen embedder seam. When provided, the free-gen
   * monologue is embedded and projected onto the 32 leaf anchors as
   * `topic_coverage_per_leaf` (SPEC §4 carve-out — Decision DCC).
   * Absent ⇒ phase 2 skipped, only `freegen_text` is persisted.
   */
  embed?: EmbedFn;
  /**
   * Free-gen probe master switch (« Parler libre » checkbox). Default
   * ON (`undefined` ⇒ true) — phase 1 makes the model talk and persists
   * `freegen_text`, phase 2 projects it if `embed` is available. Set to
   * `false` to skip the probe entirely: characterization is then the
   * QCM staircase only (faster, no extra ~600-800-word generation).
   */
  freegen?: boolean;
  /** All injectable for offline tests. */
  treeSuite?: Suite;
  qcmSuite?: Suite;
  loadExisting?: (p: string) => Promise<Signature | undefined>;
  persist?: (
    p: string,
    s: Signature,
    o: { skipWrite?: boolean },
  ) => Promise<{ written: boolean; sidecarPath: string }>;
  computeHash?: (p: string) => Promise<string>;
  now?: () => string;
  /**
   * Bulk-cancel propagation. When the user clicks the bulk-characterise
   * « Cancel » button, this signal aborts every chat call in the tree
   * pass (staircase branches + QCM reliability + free-gen phase 1).
   * Without it, cancel during the tree pass was silently ignored — the
   * model kept generating, the UI looked frozen, and llama-server
   * stayed alive past the « cancel » click. Plumbed through to
   * `characterizeBranch`, `measureQcmReliability`, and
   * `generateFreeGenText` (each forwards into `ask.complete({ signal })`).
   */
  signal?: AbortSignal;
};

export type CharacterizeTreeResult = {
  signature: Signature;
  written: boolean;
  sidecarPath: string;
  branchesOpened: string[];
  leavesMeasured: number;
  leavesFromQcmPrior: number;
};

/** Group a suite's tree items into `branch → leaf → items`. */
function groupByBranchLeaf(
  prompts: DiagnosticPrompt[],
): Record<string, Record<string, DiagnosticPrompt[]>> {
  const out: Record<string, Record<string, DiagnosticPrompt[]>> = {};
  for (const p of prompts) {
    if (!p.leaf) continue;
    const branch = p.leaf.split('.')[0];
    ((out[branch] ??= {})[p.leaf] ??= []).push(p);
  }
  return out;
}

/**
 * Characterize one model over the frozen tree + QCM bank and persist the
 * v0 signature fields. Never throws on per-item failures (the staircase /
 * QCM modules swallow them); a hard I/O failure in `persist` propagates.
 */
export async function characterizeTree(
  opts: CharacterizeTreeOptions,
): Promise<CharacterizeTreeResult> {
  const tree = opts.treeSuite ?? (treeV0 as unknown as Suite);
  const qcm = opts.qcmSuite ?? (qcmV0 as unknown as Suite);
  const loadExisting = opts.loadExisting ?? loadSignature;
  const persist = opts.persist ?? saveSignature;
  const now = opts.now ?? (() => new Date().toISOString());
  const computeHash =
    opts.computeHash ??
    (async (p: string) => (await computeModelHash(p)).modelHash);
  const qcmDiscount = opts.qcmPriorDiscount ?? DEFAULT_QCM_PRIOR_DISCOUNT;

  const modelHash = await computeHash(opts.modelFilePath);
  const existing = await loadExisting(opts.modelFilePath);
  const base =
    existing ??
    makePendingSignature({
      modelHash,
      structural: STUB_STRUCTURAL,
      suiteVersion: tree.id,
    });

  const grouped = groupByBranchLeaf(tree.prompts);
  const scores_per_leaf: Record<string, number> = {};
  const branch_scores: Partial<Record<CompetenceBranch, number>> = {};
  const n_per_leaf: Record<string, number> = {};
  const passes_per_leaf: Record<string, number> = {};
  const branchesOpened: string[] = [];

  // Slice 6a: R5 (mapped) drives which branches the staircase deepens.
  // Explicit override wins; else derive from the (R5) signature loaded
  // above; else {} ⇒ characterizeBranch self-probes (back-compat).
  const gateMap =
    opts.branchGate ?? branchGateFromAxes(base.behavioral?.scores_per_axis);

  for (const branch of Object.keys(COMPETENCE_TREE)) {
    // Honour the bulk-cancel between branches so a multi-branch tree
    // pass stops within seconds of the click instead of plowing
    // through every remaining branch.
    if (opts.signal?.aborted) {
      throw new Error('characterizeTree: aborted by caller');
    }
    const itemsByLeaf = grouped[branch];
    if (!itemsByLeaf) continue;
    const bm = await characterizeBranch(branch, itemsByLeaf, opts.ask, {
      thetaOpen: opts.thetaOpen,
      seams: opts.seams,
      branchGate: gateMap[branch as CompetenceBranch],
      signal: opts.signal,
    });
    if (bm.branch_score !== undefined)
      branch_scores[branch as CompetenceBranch] = bm.branch_score;
    if (bm.opened) branchesOpened.push(branch);
    Object.assign(scores_per_leaf, bm.scores_per_leaf);
    Object.assign(n_per_leaf, bm.n_per_leaf);
    Object.assign(passes_per_leaf, bm.passes_per_leaf);
  }
  const leavesMeasured = Object.keys(scores_per_leaf).length;

  // QCM: judge-candidacy facet + Dyy/D12 dual-purpose leaf prior. The
  // prior only fills leaves the staircase did NOT measure (never
  // replaces a real rung), already discounted (low confidence). NOTE:
  // QCM-prior leaves DO NOT get a passes_per_leaf entry — they aren't
  // Bernoulli items, just a coarse [0,1] prior; Phase B saturation
  // detection (étape 2) keys on `passes_per_leaf[l] === n_per_leaf[l]`,
  // which absent ⇒ never triggered (correct: priors stay priors).
  if (opts.signal?.aborted) {
    throw new Error('characterizeTree: aborted by caller');
  }
  const qcmRes = await measureQcmReliability(qcm.prompts, opts.ask, {
    signal: opts.signal,
  });
  let leavesFromQcmPrior = 0;
  for (const [leaf, prior] of Object.entries(qcmRes.leaf_priors)) {
    if (leaf in scores_per_leaf) continue; // staircase wins — never overwrite
    scores_per_leaf[leaf] = qcmDiscount * prior;
    n_per_leaf[leaf] = (n_per_leaf[leaf] ?? 0) + 1;
    leavesFromQcmPrior++;
  }

  // Slice 7c — Free-gen probe (« sonder la teuté du modèle »), two-phase
  // since 2026-05-22. Phase 1 (make the model talk for 600-800 words on
  // a topic IT picks) needs ONLY the chat client and ALWAYS runs — we
  // persist the FULL monologue as `freegen_text`. Phase 2 (embed +
  // project onto the 32 leaf anchors) needs an embedder and runs only
  // when one is wired in (`opts.embed`); it fills `topic_coverage_per_leaf`
  // — additional EVIDENCE on top of the deterministic competence scores,
  // never a replacement. With no embedder the text is kept verbatim so a
  // later pass can project it WITHOUT re-running the model.
  //
  // Re-use: if a stored `freegen_text` already exists (re-characterizing
  // a model that talked in an earlier, embedder-less pass), we DON'T make
  // it talk again — we project the stored text. So configuring the
  // embedder later and re-running costs zero extra free-gen generations.
  //
  // Probe failure is ISOLATED (try/catch): a flaky embedder, an empty
  // response, an over-aligned model that refuses — none of these sink
  // the tree pass we already computed.
  let topic_coverage_per_leaf: Record<string, number> | undefined;
  let topic_coverage_per_branch: Record<string, number> | undefined;
  let freegen_words: number | undefined;
  let freegen_text: string | undefined;
  // `opts.freegen === false` (the « Parler libre » checkbox unchecked)
  // skips the probe entirely — characterization is the QCM staircase
  // only. Default ON (`undefined` ⇒ true).
  if (opts.freegen !== false) {
    try {
      const priorText = base.behavioral?.freegen_text;
      if (priorText) {
        freegen_text = priorText;
        freegen_words =
          base.behavioral?.freegen_words ??
          priorText.split(/\s+/).filter(Boolean).length;
      } else {
        const gen = await generateFreeGenText(opts.ask, {
          signal: opts.signal,
        });
        freegen_text = gen.text;
        freegen_words = gen.words;
      }
      if (opts.embed) {
        const proj = await projectFreeGenText(
          freegen_text,
          opts.embed,
          probeAnchors as unknown as ProbeAnchorBank,
        );
        topic_coverage_per_leaf = proj.topic_coverage_per_leaf;
        topic_coverage_per_branch = proj.topic_coverage_per_branch;
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(
        `freegen probe failed (tree kept): ${(e as Error).message}`,
      );
    }
  }

  const prevBehavioral: BehavioralSignature = base.behavioral ?? {
    diagnostic_run: {},
    scores_per_axis: {},
    behavior_centroid: [],
  };
  const behavioral: BehavioralSignature = {
    ...prevBehavioral,
    scores_per_leaf,
    branch_scores,
    n_per_leaf,
    passes_per_leaf,
    scoring_scheme: 'beta-laplace-v1',
    ...(topic_coverage_per_leaf ? { topic_coverage_per_leaf } : {}),
    ...(topic_coverage_per_branch ? { topic_coverage_per_branch } : {}),
    ...(freegen_words != null ? { freegen_words } : {}),
    ...(freegen_text ? { freegen_text } : {}),
  };

  const signature: Signature = {
    ...base,
    behavioral,
    qcm_reliability: qcmRes.qcm_reliability,
    characterization_state: 'complete',
    characterization_error: null,
    characterized_at: now(),
    suite_version: tree.id,
  };

  const { written, sidecarPath } = await persist(
    opts.modelFilePath,
    signature,
    { skipWrite: opts.skipWrite },
  );

  return {
    signature,
    written,
    sidecarPath,
    branchesOpened,
    leavesMeasured,
    leavesFromQcmPrior,
  };
}
