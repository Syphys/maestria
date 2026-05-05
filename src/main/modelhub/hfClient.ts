/**
 * Minimal Hugging Face Hub API client used by Models Hub enrichment.
 * Anonymous works for public models (1k req/h rate limit). An optional API
 * token raises the limit to 50k/h and unlocks private repos.
 */

import https from 'https';

const HF_HOST = 'huggingface.co';
const USER_AGENT = 'TagSpaces-ModelsHub/0.1';

export interface HfRequestOptions {
  apiToken?: string;
  /** Timeout in ms. Default 15s. */
  timeoutMs?: number;
}

export interface HfModelInfo {
  id: string;
  modelId?: string;
  author?: string;
  pipeline_tag?: string;
  tags?: string[];
  downloads?: number;
  likes?: number;
  lastModified?: string;
  cardData?: {
    license?: string;
    base_model?: string | string[];
    [k: string]: unknown;
  };
  /** Other fields exposed by HF, kept loose. */
  [k: string]: unknown;
}

export interface HfTreeFile {
  path: string;
  type: 'file' | 'directory';
  size?: number;
  oid?: string;
  lfs?: {
    oid: string;
    size: number;
    pointerSize: number;
  };
}

export class HfHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function request<T>(
  pathName: string,
  options: HfRequestOptions,
  parser: (raw: string) => T,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    };
    if (options.apiToken) {
      headers.Authorization = `Bearer ${options.apiToken}`;
    }
    const req = https.request(
      {
        host: HF_HOST,
        path: pathName,
        method: 'GET',
        headers,
        timeout: options.timeoutMs ?? 15_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          // Cast: TS5+ tightened Buffer typings against Uint8Array
          // (SharedArrayBuffer flows differ); the runtime is identical.
          const body = Buffer.concat(
            chunks as unknown as Uint8Array[],
          ).toString('utf-8');
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            try {
              resolve(parser(body));
            } catch (e) {
              reject(e);
            }
            return;
          }
          if (status === 404) {
            reject(new HfHttpError(404, `not found: ${pathName}`));
            return;
          }
          if (status === 401 || status === 403) {
            reject(new HfHttpError(status, `auth required: ${pathName}`));
            return;
          }
          if (status === 429) {
            reject(
              new HfHttpError(
                429,
                `rate limited: ${pathName} (set hfApiKey in settings to raise the limit)`,
              ),
            );
            return;
          }
          reject(new HfHttpError(status, `HTTP ${status} for ${pathName}`));
        });
      },
    );
    req.on('error', (e) => reject(e));
    req.on('timeout', () => {
      req.destroy(new Error('HF request timed out'));
    });
    req.end();
  });
}

/** GET /api/models/{repo} → high-level model info. */
export function getModelInfo(
  repo: string,
  options: HfRequestOptions = {},
): Promise<HfModelInfo> {
  return request<HfModelInfo>(
    `/api/models/${encodeRepo(repo)}`,
    options,
    (s) => JSON.parse(s) as HfModelInfo,
  );
}

/** GET /api/models/{repo}/tree/main?recursive=true → file list with LFS oids. */
export function getModelTree(
  repo: string,
  options: HfRequestOptions = {},
): Promise<HfTreeFile[]> {
  return request<HfTreeFile[]>(
    `/api/models/${encodeRepo(repo)}/tree/main?recursive=true`,
    options,
    (s) => JSON.parse(s) as HfTreeFile[],
  );
}

/** GET /{repo}/raw/main/README.md → markdown card. */
export function getModelCard(
  repo: string,
  options: HfRequestOptions = {},
): Promise<string> {
  return request<string>(
    `/${encodeRepo(repo)}/raw/main/README.md`,
    options,
    (s) => s,
  );
}

/** Quick existence check via HEAD-equivalent (we use GET on a tiny endpoint). */
export async function repoExists(
  repo: string,
  options: HfRequestOptions = {},
): Promise<boolean> {
  try {
    await getModelInfo(repo, options);
    return true;
  } catch (e) {
    if (e instanceof HfHttpError && e.status === 404) return false;
    throw e;
  }
}

export interface HfSearchHit {
  /** Full repo id, e.g. "meta-llama/Llama-3-8B-Instruct". */
  id: string;
  modelId?: string;
  author?: string;
  downloads?: number;
  likes?: number;
  tags?: string[];
  pipeline_tag?: string;
  lastModified?: string;
}

/**
 * Search HF models by free-text query. Used as fallback when the path
 * heuristic can't infer an `<author>/<repo>` pair locally.
 * Default sort: most downloaded first (signal of "the canonical repo").
 */
export function searchModels(
  query: string,
  options: HfRequestOptions & {
    limit?: number;
    sort?: 'downloads' | 'likes' | 'lastModified';
  } = {},
): Promise<HfSearchHit[]> {
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);
  const sort = options.sort ?? 'downloads';
  const params = new URLSearchParams({
    search: query,
    limit: String(limit),
    sort,
    direction: '-1',
    full: 'true',
  });
  return request<HfSearchHit[]>(
    `/api/models?${params.toString()}`,
    options,
    (s) => JSON.parse(s) as HfSearchHit[],
  );
}

function encodeRepo(repo: string): string {
  // HF repos are author/model — both segments URL-safe but slashes preserved
  return repo
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}
