/**
 * Ollama-specific glue.
 *
 * Ollama doesn't accept a raw .gguf path on its CLI — every model must be
 * registered through `ollama create <name> -f Modelfile` first. This module
 * automates that step so the UI can offer "Run" without the user having to
 * understand Modelfiles.
 *
 * Daemon handling: on Windows, Ollama's installer registers a background
 * service that listens on 11434. Spawning a second `ollama serve` would
 * collide. We probe the daemon via `ollama list` first; only spawn when
 * unreachable.
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { RunParams } from '../../../renderer/modelhub/types';

/** Sanitize a filename into a valid Ollama model name. */
export function ollamaModelName(ggufPath: string): string {
  const base = path.basename(ggufPath, path.extname(ggufPath));
  const sanitized = ('tagspaces-' + base.toLowerCase())
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  // Ollama tag length cap is generous but keep it readable.
  return sanitized.slice(0, 80);
}

/** Probe the Ollama daemon. Reachable when `ollama list` exits 0. */
export function isOllamaDaemonRunning(ollamaPath: string): boolean {
  try {
    const r = spawnSync(ollamaPath, ['list'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

function isModelRegistered(ollamaPath: string, name: string): boolean {
  try {
    const r = spawnSync(ollamaPath, ['list'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
    });
    if (r.status !== 0) return false;
    // `ollama list` outputs a header row + one model per row, name in col 1.
    const re = new RegExp(
      `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
      'm',
    );
    return re.test(r.stdout);
  } catch {
    return false;
  }
}

export interface PrepareResult {
  ok: boolean;
  modelName: string;
  alreadyRegistered: boolean;
  modelfilePath?: string;
  output?: string;
  error?: string;
}

/**
 * Idempotently register a .gguf with Ollama using auto-tuned params.
 * Returns the model name the user can `ollama run`. Safe to call repeatedly:
 * already-registered models are detected and skipped.
 */
export async function prepareOllamaModel(
  ollamaPath: string,
  ggufPath: string,
  params: RunParams,
): Promise<PrepareResult> {
  const modelName = ollamaModelName(ggufPath);

  if (isModelRegistered(ollamaPath, modelName)) {
    return { ok: true, modelName, alreadyRegistered: true };
  }

  // Build the Modelfile. PARAMETER lines are optional — Ollama applies
  // sensible defaults when missing, so we only emit what we computed.
  const lines = [`FROM ${ggufPath}`];
  if (typeof params.ctx === 'number') {
    lines.push(`PARAMETER num_ctx ${params.ctx}`);
  }
  if (typeof params.ngl === 'number' && params.ngl >= 0) {
    // -1 ("all layers") is a llama.cpp-ism; Ollama wants a concrete number
    // or the param omitted to let it auto-decide.
    lines.push(`PARAMETER num_gpu ${params.ngl}`);
  }
  if (typeof params.threads === 'number') {
    lines.push(`PARAMETER num_thread ${params.threads}`);
  }
  const modelfileContent = lines.join('\n') + '\n';

  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'tagspaces-modelfile-'),
  );
  const modelfilePath = path.join(tmpDir, 'Modelfile');
  await fs.writeFile(modelfilePath, modelfileContent, 'utf8');

  try {
    // Create can take a while on big models — Ollama copies / blob-deduplicates.
    const create = spawnSync(
      ollamaPath,
      ['create', modelName, '-f', modelfilePath],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5 * 60 * 1000,
      },
    );
    const output = (create.stdout ?? '') + (create.stderr ?? '');
    if (create.status !== 0) {
      return {
        ok: false,
        modelName,
        alreadyRegistered: false,
        modelfilePath,
        output,
        error: `ollama create exited with code ${create.status}: ${output.trim().slice(0, 400)}`,
      };
    }
    return {
      ok: true,
      modelName,
      alreadyRegistered: false,
      modelfilePath,
      output,
    };
  } catch (e) {
    return {
      ok: false,
      modelName,
      alreadyRegistered: false,
      modelfilePath,
      error: (e as Error).message,
    };
  }
}
