/**
 * Hugging Face enrichment orchestrator.
 *
 * Pipeline:
 *   1. Load existing sidecar (header may already be cached from enrichLocal)
 *   2. If no header, parse it now
 *   3. Compute candidate HF repos (path heuristic + header)
 *   4. Probe each candidate via HF API; first 200 wins
 *   5. Fetch model card markdown + repo metadata
 *   6. Re-derive auto-tags including HF data (license, pipelineTag)
 *   7. Patch sidecar
 */

import { computeAutoTags } from '../../renderer/modelhub/autoTags';
import { HfMeta, ModelMeta } from '../../renderer/modelhub/types';
import { computeFolderSegments } from './folderTags';
import { resolveCanonicalShardPath } from './shardFs';
import {
  HfHttpError,
  HfRequestOptions,
  getModelCard,
  getModelInfo,
  searchModels,
} from './hfClient';
import {
  guessRepoCandidates,
  stripQuantizationSuffixes,
  RepoCandidate,
} from './hfHeuristic';
import { readModelHeader } from './parseHeader';
import { loadModelMeta, patchModelMeta } from './sidecar';

export interface EnrichHfOptions {
  /** HF API token (optional; raises rate limit, unlocks private repos). */
  apiToken?: string;
  /** Skip writing the sidecar (read-only locations). */
  skipWrite?: boolean;
  /** Force re-fetch even if cached recently. */
  force?: boolean;
  /** Cache TTL in ms before considering HF data stale. Default 7 days. */
  cacheTtlMs?: number;
  /** Override repo candidates instead of using the heuristic (for manual selection). */
  candidates?: RepoCandidate[];
  /** Location root for `dir:<segment>` auto-tags. Same semantics as enrichLocal. */
  rootDir?: string;
}

export interface EnrichHfResult {
  ok: boolean;
  modelMeta?: ModelMeta;
  autoTags?: string[];
  matchedRepo?: string;
  matchedFromCandidate?: RepoCandidate;
  triedCandidates?: RepoCandidate[];
  sidecarPath?: string;
  written?: boolean;
  fromCache?: boolean;
  error?: string;
}

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function isFresh(cachedAt: string | undefined, ttlMs: number): boolean {
  if (!cachedAt) return false;
  const age = Date.now() - new Date(cachedAt).getTime();
  return age < ttlMs;
}

/**
 * Build ordered list of search queries for the HF search fallback.
 * Most specific first. De-duplicated case-insensitively. Capped at 3 to keep
 * the network footprint polite.
 */
function buildSearchTerms(
  filePath: string,
  header: { basename?: string; name?: string } | undefined,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (s: string | undefined): void => {
    if (!s) return;
    const trimmed = s.trim();
    if (!trimmed || trimmed.length < 3) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(trimmed);
  };

  // 1. header.basename (canonical name from inside the file)
  add(header?.basename);
  // 2. Stripped header.name
  add(header?.name ? stripQuantizationSuffixes(header.name) : undefined);
  // 3. Parent folder name (often the model name when users mirror locally)
  const parts = filePath.split(/[\\/]+/).filter((s) => s.length > 0);
  if (parts.length >= 2) add(parts[parts.length - 2]);
  // 4. Stripped filename
  if (parts.length >= 1) {
    const fname = parts[parts.length - 1];
    add(stripQuantizationSuffixes(fname.replace(/\.[^.]+$/, '')));
  }

  return out.slice(0, 3);
}

export async function enrichHf(
  filePath: string,
  options: EnrichHfOptions = {},
): Promise<EnrichHfResult> {
  const ttl = options.cacheTtlMs ?? DEFAULT_TTL_MS;
  const reqOpts: HfRequestOptions = { apiToken: options.apiToken };

  // Redirect non-canonical shard clicks to the canonical entry — see
  // MODELS_HUB_SHARDS.md. Without this, calling enrichHf on shard 7
  // would write a sibling sidecar that the rest of the app ignores.
  const canonicalPath = await resolveCanonicalShardPath(filePath);

  // 1. Load existing sidecar
  const existing = await loadModelMeta(canonicalPath);

  const folderSegments = computeFolderSegments(canonicalPath, options.rootDir);

  // Cache short-circuit
  if (
    !options.force &&
    existing?.huggingface?.cachedAt &&
    isFresh(existing.huggingface.cachedAt, ttl)
  ) {
    const autoTags = computeAutoTags({
      header: existing.header,
      huggingface: existing.huggingface,
      folderSegments,
    });
    return {
      ok: true,
      modelMeta: existing,
      autoTags,
      matchedRepo: existing.huggingface.repo,
      sidecarPath: undefined,
      written: false,
      fromCache: true,
    };
  }

  // 2. Make sure we have a header (parse on demand)
  let header = existing?.header;
  if (!header) {
    const headerResult = await readModelHeader(canonicalPath);
    if (!headerResult.ok || !headerResult.meta) {
      return { ok: false, error: headerResult.error ?? 'header parse failed' };
    }
    header = headerResult.meta;
  }

  // 3. Candidate list (from heuristic or caller-provided)
  const heuristicCandidates =
    options.candidates ?? guessRepoCandidates(canonicalPath, header);

  // 4. Probe heuristic candidates in confidence order
  const tried: RepoCandidate[] = [];
  let matched: RepoCandidate | undefined;
  let info: Awaited<ReturnType<typeof getModelInfo>> | undefined;
  let lastError: string | undefined;
  let networkAborted = false;

  const sortByConfidence = (a: RepoCandidate, b: RepoCandidate) => {
    const order = { high: 0, medium: 1, low: 2 } as const;
    return order[a.confidence] - order[b.confidence];
  };

  for (const c of [...heuristicCandidates].sort(sortByConfidence)) {
    tried.push(c);
    try {
      info = await getModelInfo(c.repo, reqOpts);
      matched = c;
      break;
    } catch (e) {
      if (e instanceof HfHttpError) {
        // 404 = doesn't exist; 401/403 = private or doesn't exist (HF returns
        // 401 for non-existent paths sometimes). In both cases, skip and try
        // the next candidate rather than aborting.
        if (e.status === 404 || e.status === 401 || e.status === 403) {
          continue;
        }
        if (e.status === 429) {
          lastError = e.message;
          networkAborted = true;
          break;
        }
      }
      lastError = (e as Error).message;
      networkAborted = true;
      break;
    }
  }

  // 4b. Fallback: HF search by name when heuristic gives nothing or all 404'd
  if (!matched && !networkAborted) {
    const searchTerms = buildSearchTerms(canonicalPath, header);
    for (const term of searchTerms) {
      try {
        const hits = await searchModels(term, {
          ...reqOpts,
          limit: 5,
          sort: 'downloads',
        });
        for (const hit of hits) {
          const candidate: RepoCandidate = {
            repo: hit.id,
            source: 'filename+author',
            confidence: 'low',
          };
          if (
            tried.some((t) => t.repo.toLowerCase() === hit.id.toLowerCase())
          ) {
            continue;
          }
          tried.push(candidate);
          try {
            info = await getModelInfo(hit.id, reqOpts);
            matched = candidate;
            break;
          } catch (e) {
            if (e instanceof HfHttpError) {
              if (e.status === 404 || e.status === 401 || e.status === 403) {
                continue;
              }
              if (e.status === 429) {
                lastError = e.message;
                networkAborted = true;
                break;
              }
            }
            lastError = (e as Error).message;
            networkAborted = true;
            break;
          }
        }
      } catch (e) {
        if (
          e instanceof HfHttpError &&
          (e.status === 401 || e.status === 403)
        ) {
          // Auth error — search not available without token; stop trying.
          break;
        }
        lastError = (e as Error).message;
        networkAborted = true;
        break;
      }
      if (matched || networkAborted) break;
    }
  }

  if (!matched || !info) {
    return {
      ok: false,
      error:
        lastError ??
        `none of ${tried.length} candidate${tried.length === 1 ? '' : 's'} matched on Hugging Face`,
      triedCandidates: tried,
    };
  }

  // 5. Fetch model card markdown (optional — failure is non-fatal)
  let descriptionEN: string | undefined;
  try {
    descriptionEN = await getModelCard(matched.repo, reqOpts);
  } catch {
    // README missing or rate-limited; skip silently
  }

  // 6. Build HF metadata + recompute auto-tags
  const license =
    typeof info.cardData?.license === 'string'
      ? info.cardData!.license
      : undefined;
  const hfMeta: HfMeta = {
    repo: matched.repo,
    pipelineTag: info.pipeline_tag,
    license,
    tags: Array.isArray(info.tags) ? info.tags : undefined,
    downloads: typeof info.downloads === 'number' ? info.downloads : undefined,
    likes: typeof info.likes === 'number' ? info.likes : undefined,
    lastModified:
      typeof info.lastModified === 'string' ? info.lastModified : undefined,
    descriptionEN,
    cachedAt: new Date().toISOString(),
  };

  const autoTags = computeAutoTags({
    header,
    huggingface: hfMeta,
    folderSegments,
  });

  // 7. Patch sidecar
  const patch: Partial<ModelMeta> = {
    header,
    huggingface: hfMeta,
    autoTags,
    lastEnrichedAt: new Date().toISOString(),
  };

  try {
    const writeResult = await patchModelMeta(canonicalPath, patch, {
      skipWrite: options.skipWrite,
      syncSystemTags: autoTags,
    });
    return {
      ok: true,
      modelMeta: writeResult.modelMeta,
      autoTags,
      matchedRepo: matched.repo,
      matchedFromCandidate: matched,
      triedCandidates: tried,
      sidecarPath: writeResult.sidecarPath,
      written: writeResult.written,
      fromCache: false,
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message, triedCandidates: tried };
  }
}
