// Slice 5b-core — projector switch: vector routing with R5 fallback.
//
// "Auto if available": when a routing embedder is configured, the query
// is projected onto the cached probe anchors and ranked by the
// competence tree (slice 5a). The embedding_reliability gate (SPEC §4)
// is REALLY enforced here — measured once per embedder and cached;
// below threshold (or any embed failure, or no embedder) we silently
// fall back to the R5 deterministic classifier. Never blocks, always
// returns a ranking.
//
// Perf (retro dette C): anchors are embedded ONCE per embedder and
// cached for the process; only the single query vector is embedded per
// route. Reliability is likewise measured once and cached.
//
// Pure over injected seams (embed factory + cache) ⇒ fully offline-test.

import {
  type EmbeddingReliability,
  type EmbeddingTripletBank,
  type ProbeAnchorBank,
} from '../../../shared/RoutingTypes';
import {
  anchorOrder,
  measureEmbeddingReliability,
  projectFromVectors,
  projectorGate,
  type EmbedFn,
} from './embedProject';
import {
  routeByVectors,
  type RouteByVectorsResult,
  type VectorRouteResult,
} from './routeByVectors';
import {
  routeQuery,
  type RouteCandidate,
  type RouteResources,
  type RouteResult,
  type RouteWeights,
} from './router';
import { EmbedClient } from './embed';
import probeAnchors from './questions/probe-anchors.json';
import embeddingTriplets from './questions/embedding-triplets.json';

export type EmbedderRef = { baseUrl: string; model?: string };
export type EmbedFactory = (e: EmbedderRef) => EmbedFn;

/** Per-embedder warm cache (anchors embedded once, reliability once). */
export interface EmbedderCache {
  get(
    id: string,
  ):
    | { anchors?: Float32Array[]; reliability?: EmbeddingReliability }
    | undefined;
  setAnchors(id: string, anchors: Float32Array[]): void;
  setReliability(id: string, r: EmbeddingReliability): void;
}

/** Default process-lifetime in-memory cache. */
class MemoryCache implements EmbedderCache {
  private m = new Map<
    string,
    { anchors?: Float32Array[]; reliability?: EmbeddingReliability }
  >();

  get(id: string) {
    return this.m.get(id);
  }

  setAnchors(id: string, anchors: Float32Array[]) {
    this.m.set(id, { ...this.m.get(id), anchors });
  }

  setReliability(id: string, reliability: EmbeddingReliability) {
    this.m.set(id, { ...this.m.get(id), reliability });
  }
}
const sharedCache = new MemoryCache();

const defaultFactory: EmbedFactory = (e) => {
  const c = new EmbedClient({ baseUrl: e.baseUrl, model: e.model });
  return (texts: string[]) => c.embed(texts);
};

export type DecideRouteOptions = {
  query: string;
  candidates: RouteCandidate[];
  resources?: RouteResources;
  weights?: RouteWeights;
  /** Set ⇒ try the vector path; absent ⇒ R5 only. */
  embedder?: EmbedderRef;
  params?: { thetaQ?: number; embeddingReliabilityThreshold?: number };
  // Injectable for tests / packaging:
  anchors?: ProbeAnchorBank;
  triplets?: EmbeddingTripletBank;
  embedFactory?: EmbedFactory;
  cache?: EmbedderCache;
};

export type DecideRouteResult = {
  routedBy: 'vector' | 'r5';
  gateReason: string;
  reliability?: EmbeddingReliability;
  /** Vector path only: chosen comparison level per branch. */
  level?: RouteByVectorsResult['level'];
  ranked: VectorRouteResult[] | RouteResult[];
  best?: VectorRouteResult | RouteResult;
  /** R5 path only: derived axis weights (kept for transparency). */
  axisWeights?: ReturnType<typeof routeQuery>['axisWeights'];
};

function r5(
  reason: string,
  o: DecideRouteOptions,
  reliability?: EmbeddingReliability,
): DecideRouteResult {
  const { axisWeights, ranked, best } = routeQuery(
    o.query,
    o.candidates,
    o.resources ?? {},
    o.weights ?? {},
  );
  return {
    routedBy: 'r5',
    gateReason: reason,
    reliability,
    axisWeights,
    ranked,
    best,
  };
}

/**
 * Decide and rank. Vector path iff an embedder is configured AND its
 * measured reliability passes the gate AND embedding succeeds; otherwise
 * a transparent R5 fallback (the `gateReason` always says why).
 */
export async function decideRoute(
  o: DecideRouteOptions,
): Promise<DecideRouteResult> {
  const embedder = o.embedder;
  if (!embedder?.baseUrl) return r5('no routing embedder configured → R5', o);

  const anchors = o.anchors ?? (probeAnchors as unknown as ProbeAnchorBank);
  const triplets =
    o.triplets ?? (embeddingTriplets as unknown as EmbeddingTripletBank);
  const factory = o.embedFactory ?? defaultFactory;
  const cache = o.cache ?? sharedCache;
  const id = `${embedder.baseUrl}::${embedder.model ?? ''}`;

  try {
    const embed = factory(embedder);

    let reliability = cache.get(id)?.reliability;
    if (!reliability) {
      reliability = await measureEmbeddingReliability(triplets, embed);
      cache.setReliability(id, reliability);
    }
    const gate = projectorGate(
      reliability,
      o.params?.embeddingReliabilityThreshold,
    );
    if (!gate.useEmbedding) return r5(gate.reason, o, reliability);

    const { branchIds, leafIds, texts } = anchorOrder(anchors);
    let anchorVecs = cache.get(id)?.anchors;
    if (!anchorVecs) {
      anchorVecs = await embed(texts);
      cache.setAnchors(id, anchorVecs);
    }
    const [queryVec] = await embed([o.query]);
    const proj = projectFromVectors(queryVec, anchorVecs, branchIds, leafIds);
    const vr = routeByVectors(
      proj,
      o.candidates,
      o.resources ?? {},
      o.weights ?? {},
      { thetaQ: o.params?.thetaQ },
    );
    return {
      routedBy: 'vector',
      gateReason: gate.reason,
      reliability,
      level: vr.level,
      ranked: vr.ranked,
      best: vr.best,
    };
  } catch (e) {
    return r5(`embedding failed: ${(e as Error).message} → R5`, o);
  }
}
