// Slice 5 single-pass (2026-05-23) — one-shot embedder via `llama-embedding`.
//
// Bulk characterization (« Tout caractériser ») runs many model tests
// back-to-back. Each test loads a model into RAM; if we ALSO kept an
// embedding-server resident, both would compete for VRAM and the user
// would lose ~600 MB to a model that's only needed for a ~3 s projection
// at the end of each test. The previous two-pass design batched all
// embeddings at the end (embedder loaded once), but that forced the user
// to wait for ALL tests to finish before seeing any projection.
//
// llama.cpp ships a dedicated CLI for exactly this: `llama-embedding.exe`
// (next to `llama-server.exe` in the same build folder). It loads the
// model, embeds, prints JSON, exits. One process per invocation, zero
// resident memory between calls. That lets `characterizeAll` keep its
// natural per-model rhythm: test → embed → next, with the embedder
// process living for ~3 s × N models instead of ~N×3 s permanent.
//
// We use `--embd-output-format json` (OpenAI-shaped: `{ data: [{ index,
// embedding }] }`) so the parsing path mirrors `EmbedClient` exactly. We
// pass texts via a temp file with a custom separator (`--embd-separator
// <#sep#>`) — passing on the command line would break Windows ARG_MAX on
// long anchor batches (~17 anchors × 30 words). The temp file is cleaned
// up unconditionally (success or failure).
//
// Every external effect is injectable so this is unit-testable offline:
// `spawnFn` substitutes for `child_process.spawn`, `fsWriteFile` /
// `fsUnlink` for `fs.promises`, `getRunnerPath` for the registry lookup.

import { spawn as nodeSpawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { randomBytes } from 'crypto';
import { listRunners } from '../runners/registry';
import { getRoutingConfig, effectiveRoutingParams } from '../routingConfig';
import type { EmbedFn } from './embedProject';

/** What the user actually sees when llama-embedding misbehaves. */
export class EmbedderCliError extends Error {
  constructor(
    message: string,
    readonly exitCode?: number | null,
    readonly stderrTail?: string,
  ) {
    super(message);
    this.name = 'EmbedderCliError';
  }
}

/**
 * Separator written into the input file between texts. Same form the
 * llama-embedding help suggests (`<#sep#>`); long enough that it cannot
 * collide with any natural sequence in a free-gen monologue or anchor.
 */
const EMBD_SEPARATOR = '<#sep#>';

/** Default per-spawn wall-clock budget — slow CPU embedder + cold cache. */
const DEFAULT_TIMEOUT_MS = 180_000;

interface SpawnLike {
  stdout: { on(event: 'data', cb: (chunk: Buffer) => void): unknown } | null;
  stderr: { on(event: 'data', cb: (chunk: Buffer) => void): unknown } | null;
  on(event: 'error', cb: (err: Error) => void): unknown;
  on(event: 'exit', cb: (code: number | null) => void): unknown;
  kill(signal?: string): void;
}

type SpawnFn = (
  cmd: string,
  args: string[],
  opts: { windowsHide: boolean },
) => SpawnLike;

export interface EmbedCliOptions {
  /** Absolute path to `llama-embedding(.exe)`. */
  binPath: string;
  /** Absolute path to the embedding GGUF. */
  modelPath: string;
  /** Texts to embed (1+; order preserved on output). */
  texts: string[];
  /** Per-spawn timeout in ms (default 180 000). */
  timeoutMs?: number;
  /** Extra CLI args appended verbatim (e.g. `['-c', '8192']`). */
  extraArgs?: string[];
  /** Test seam — defaults to `child_process.spawn`. */
  spawnFn?: SpawnFn;
  /** Test seam — defaults to `fs.promises.writeFile`. */
  fsWriteFile?: (file: string, data: string) => Promise<void>;
  /** Test seam — defaults to `fs.promises.unlink`. */
  fsUnlink?: (file: string) => Promise<void>;
  /** Test seam — defaults to `os.tmpdir()`. */
  tmpDir?: string;
}

/** OpenAI-style payload llama-embedding prints with `--embd-output-format json`. */
interface JsonOutput {
  data?: { index: number; embedding: number[] | string }[];
}

/** llama.cpp returns `number[]`; same code path EmbedClient uses. */
function toFloat32(embedding: number[] | string): Float32Array {
  if (typeof embedding === 'string') {
    const buf = Buffer.from(embedding, 'base64');
    return new Float32Array(
      buf.buffer,
      buf.byteOffset,
      Math.floor(buf.byteLength / 4),
    );
  }
  return Float32Array.from(embedding);
}

/**
 * Extract the JSON payload from stdout. `--log-disable` keeps llama.cpp
 * quiet but ROCm/CUDA init lines come from the GPU runtime itself, not
 * the logger, so a banner still slips in. We find the last `{ ... }`
 * block that parses cleanly — the OpenAI JSON object the CLI emits is
 * always the very last thing on stdout.
 */
function parseJsonOutput(stdout: string): JsonOutput {
  // Cheap path: the whole stdout parses (best case, log-disable worked).
  try {
    return JSON.parse(stdout) as JsonOutput;
  } catch {
    /* fall through to scan */
  }
  // Find the last `{`-prefixed line region that parses. Walks backwards
  // so a banner that happens to contain `{` doesn't shadow the real
  // payload at the tail.
  const opens: number[] = [];
  for (let i = 0; i < stdout.length; i++) {
    if (stdout[i] === '{') opens.push(i);
  }
  for (let i = opens.length - 1; i >= 0; i--) {
    const slice = stdout.slice(opens[i]).trim();
    try {
      return JSON.parse(slice) as JsonOutput;
    } catch {
      /* try the next opener */
    }
  }
  throw new EmbedderCliError(
    `llama-embedding: stdout had no JSON payload (got ${stdout.length} bytes)`,
  );
}

/**
 * Spawn `llama-embedding` once, embed every text in `opts.texts`,
 * resolve with one `Float32Array` per text in input order. Throws
 * `EmbedderCliError` on any failure (process spawn error, non-zero
 * exit, missing JSON, wrong vector count). The temp file is always
 * cleaned up before this returns.
 */
export async function embedViaLlamaCli(
  opts: EmbedCliOptions,
): Promise<Float32Array[]> {
  if (opts.texts.length === 0) return [];

  const spawn = opts.spawnFn ?? (nodeSpawn as unknown as SpawnFn);
  const writeFile = opts.fsWriteFile ?? ((f, d) => fs.writeFile(f, d, 'utf8'));
  const unlink = opts.fsUnlink ?? ((f) => fs.unlink(f).catch(() => undefined));
  const tmpDir = opts.tmpDir ?? os.tmpdir();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Random suffix so concurrent calls don't share a path (we never run
  // bulk characterization in parallel, but routing queries might fire).
  const tmp = path.join(
    tmpDir,
    `maestria-embed-${Date.now()}-${randomBytes(4).toString('hex')}.txt`,
  );
  await writeFile(tmp, opts.texts.join(EMBD_SEPARATOR));

  try {
    const args = [
      '-m',
      opts.modelPath,
      '-f',
      tmp,
      '--embd-separator',
      EMBD_SEPARATOR,
      '--embd-output-format',
      'json',
      '--embd-normalize',
      '2', // L2 normalize ⇒ projector's cosine math stays correct
      '--log-disable', // silence load banner so stdout is (mostly) pure JSON
      ...(opts.extraArgs ?? []),
    ];

    const child = spawn(opts.binPath, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already dead */
      }
    }, timeoutMs);

    const result = await new Promise<{ code: number | null }>(
      (resolve, reject) => {
        child.stdout?.on('data', (d: Buffer) => {
          stdout += d.toString('utf8');
        });
        child.stderr?.on('data', (d: Buffer) => {
          stderr += d.toString('utf8');
        });
        child.on('error', (err: Error) => {
          clearTimeout(timer);
          reject(
            new EmbedderCliError(
              `llama-embedding spawn failed: ${err.message}`,
            ),
          );
        });
        child.on('exit', (code: number | null) => {
          clearTimeout(timer);
          if (timedOut) {
            reject(
              new EmbedderCliError(
                `llama-embedding timed out after ${timeoutMs} ms`,
                code,
                stderr.slice(-500),
              ),
            );
            return;
          }
          resolve({ code });
        });
      },
    );

    if (result.code !== 0) {
      throw new EmbedderCliError(
        `llama-embedding exited with code ${result.code}`,
        result.code,
        stderr.slice(-500),
      );
    }

    const json = parseJsonOutput(stdout);
    const data = json.data;
    if (!Array.isArray(data) || data.length !== opts.texts.length) {
      throw new EmbedderCliError(
        `llama-embedding: expected ${opts.texts.length} vectors, got ${data?.length ?? 0}`,
        result.code,
        stderr.slice(-500),
      );
    }
    return [...data]
      .sort((a, b) => a.index - b.index)
      .map((d) => toFloat32(d.embedding));
  } finally {
    await unlink(tmp);
  }
}

/**
 * Derive the absolute path to `llama-embedding(.exe)` from a configured
 * `llama-server(.exe)` runner path. They live side-by-side in every
 * llama.cpp build (`build/bin/`), so swapping the basename is a stable
 * convention. Returns undefined when the input path doesn't look like a
 * llama-server.
 *
 * Preserves the input's path separator (`\` on Windows, `/` on POSIX)
 * rather than going through `path.join` — that way a POSIX-style path
 * resolved on Windows still comes back as POSIX (and vice versa).
 */
export function deriveLlamaEmbeddingPath(
  runnerPath: string,
): string | undefined {
  // Capture the leading dir (with its separator), the basename prefix
  // (if any — empty for the common `llama-server.exe` case), and the
  // optional extension. We do this with one regex so the separator the
  // user wrote is kept verbatim.
  const m = runnerPath.match(/^(.*[\\/])?(.*)llama-server(\.[^.\\/]+)?$/i);
  if (!m) return undefined;
  const dirPrefix = m[1] ?? '';
  const filePrefix = m[2] ?? '';
  const ext = m[3] ?? '';
  return `${dirPrefix}${filePrefix}llama-embedding${ext}`;
}

export interface ResolveEmbedderCliDeps {
  listRunners?: typeof listRunners;
  getRoutingConfig?: typeof getRoutingConfig;
  /** Test seam — defaults to `fs.promises.access`. */
  fileExists?: (filePath: string) => Promise<boolean>;
}

async function defaultFileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build an `EmbedFn` backed by the one-shot CLI. Resolves the embedder
 * model path from the routing config (managed mode only — `kind:
 * 'managed'`), and derives `llama-embedding` from the first configured
 * llama-server runner. Throws when either piece is missing — the caller
 * (`characterizeAll`) catches the throw and falls back to skipping
 * projections silently.
 *
 * External embedders (`kind: 'external'`, user-managed URL) are NOT
 * supported by this CLI path: by definition we don't own that process,
 * we just talk to it. For bulk runs the user can either point the
 * external URL at a llama-server they control, or accept that
 * projections are skipped during bulk and the texts are projected later
 * when the routing path needs them.
 */
export async function resolveEmbedderCliFn(
  deps: ResolveEmbedderCliDeps = {},
): Promise<EmbedFn> {
  const lr = deps.listRunners ?? listRunners;
  const grc = deps.getRoutingConfig ?? getRoutingConfig;
  const exists = deps.fileExists ?? defaultFileExists;

  const cfg = await grc();
  const params = effectiveRoutingParams(cfg);
  if (!params.embedder || params.embedder.kind !== 'managed') {
    throw new Error(
      'no managed embedder configured (CLI bulk path requires a GGUF file)',
    );
  }
  const modelPath = params.embedder.filePath;
  if (!(await exists(modelPath))) {
    throw new Error(`embedder GGUF not found: ${modelPath}`);
  }

  const runners = await lr();
  // Find a llama-server we can derive llama-embedding from. Take the
  // first one — auto-detected entries come ordered by priority, manual
  // additions are user-vetted.
  let binPath: string | undefined;
  for (const r of runners) {
    const candidate = deriveLlamaEmbeddingPath(r.path);
    if (candidate && (await exists(candidate))) {
      binPath = candidate;
      break;
    }
  }
  if (!binPath) {
    throw new Error(
      'no llama-embedding binary found beside any configured llama-server',
    );
  }

  const captured = { binPath, modelPath };
  return async (texts) =>
    embedViaLlamaCli({
      binPath: captured.binPath,
      modelPath: captured.modelPath,
      texts,
    });
}
