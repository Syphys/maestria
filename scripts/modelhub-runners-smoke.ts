/**
 * Smoke test for the runner subsystem (detection, autotune, command builder).
 *
 * Run:
 *   npx ts-node --transpile-only scripts/modelhub-runners-smoke.ts
 *
 * Pure unit assertions — no Electron, no spawn, no network.
 */
/// <reference types="node" />

import { autotune } from '../src/main/modelhub/runners/autotune';
import {
  buildCommand,
  formatCommandForShell,
} from '../src/main/modelhub/runners/command';
import { detectRunners } from '../src/main/modelhub/runners/detect';
import { HeaderMeta, RunnerConfig } from '../src/renderer/modelhub/types';
import { HardwareProfile } from '../src/renderer/modelhub/hardware';

let failed = 0;
function assert(cond: boolean, msg: string, info?: unknown): void {
  if (cond) {
    console.log(
      '  ok:  ',
      msg,
      info !== undefined ? `(${JSON.stringify(info)})` : '',
    );
  } else {
    failed += 1;
    console.error(
      '  FAIL:',
      msg,
      info !== undefined ? JSON.stringify(info) : '',
    );
  }
}

function header(file: string, sizeBytes: number, blocks = 32): HeaderMeta {
  return {
    format: 'gguf',
    architecture: 'llama',
    name: file,
    fileSize: sizeBytes,
    blockCount: blocks,
    contextMax: 8192,
  };
}

const GB = 1_000_000_000;

function llamaServerRunner(): RunnerConfig {
  return {
    id: 'r1',
    kind: 'llama.cpp',
    label: 'llama.cpp (llama-server)',
    path: 'C:\\llama.cpp\\bin\\llama-server.exe',
    capabilities: { chat: true, server: true, gguf: true, safetensors: false },
    autoDetected: true,
  };
}

function ollamaRunner(): RunnerConfig {
  return {
    id: 'r2',
    kind: 'ollama',
    label: 'Ollama',
    path: '/usr/local/bin/ollama',
    capabilities: { chat: true, server: true, gguf: true, safetensors: false },
    autoDetected: true,
  };
}

console.log('--- Autotune: pure CPU (no GPU) ---');
{
  const hw: HardwareProfile = {
    source: 'detected',
    ramBytes: 32 * GB,
    cpu: { cores: 16 },
  };
  const params = autotune({
    header: header('llama.gguf', 8 * GB),
    hardware: hw,
  });
  assert(params.ngl === 0, 'ngl=0 when no GPU', params.ngl);
  assert((params.threads ?? 0) >= 1, 'threads ≥ 1', params.threads);
  assert((params.ctx ?? 0) >= 512, 'ctx is at least 512', params.ctx);
  assert(
    params.batchSize === 512,
    'CPU batch-size preset = 512',
    params.batchSize,
  );
  assert(
    params.flashAttn === false,
    'no flash-attn without GPU',
    params.flashAttn,
  );
}

console.log('--- Autotune: small GPU, big model (partial offload) ---');
{
  const hw: HardwareProfile = {
    source: 'detected',
    ramBytes: 64 * GB,
    cpu: { cores: 24 },
    gpu: { vendor: 'NVIDIA', name: 'RTX 4070', vramBytes: 12 * GB },
  };
  const params = autotune({
    header: header('big.gguf', 40 * GB, 80),
    hardware: hw,
  });
  assert((params.ngl ?? 0) > 0, 'some layers offload to GPU', params.ngl);
  assert(
    (params.ngl ?? 0) < 80,
    'not all 80 layers fit in 12 GB VRAM',
    params.ngl,
  );
  assert(params.flashAttn === true, 'flash-attn on with GPU', params.flashAttn);
}

console.log('--- Autotune: GPU >> model (full offload) ---');
{
  const hw: HardwareProfile = {
    source: 'detected',
    ramBytes: 64 * GB,
    cpu: { cores: 24 },
    gpu: { vendor: 'NVIDIA', name: 'RTX 4090', vramBytes: 24 * GB },
  };
  const params = autotune({
    header: header('llama.gguf', 4 * GB),
    hardware: hw,
  });
  assert((params.ngl ?? 0) >= 32, 'all 32 layers fit easily', params.ngl);
}

console.log('--- Command builder: llama-server ---');
{
  const built = buildCommand(
    llamaServerRunner(),
    'D:\\models\\Llama-3-8B-Q4_K_M.gguf',
    {
      ngl: 33,
      ctx: 8192,
      threads: 8,
      batchSize: 2048,
      flashAttn: true,
      port: 8080,
    },
  );
  assert(
    built.command[0].endsWith('llama-server.exe'),
    'binary path preserved',
    built.command[0],
  );
  assert(built.command.includes('--n-gpu-layers'), 'has --n-gpu-layers');
  assert(built.command.includes('33'), 'has ngl value 33');
  assert(built.command.includes('--port'), 'has --port');
  assert(
    built.url === 'http://127.0.0.1:8080',
    'url uses chosen port',
    built.url,
  );

  const shell = formatCommandForShell(built.command);
  assert(shell.includes('Llama-3-8B'), 'shell string contains model name');
}

console.log('--- Command builder: ollama warns on raw path ---');
{
  const built = buildCommand(ollamaRunner(), '/models/foo.gguf', {
    port: 11434,
  });
  assert(
    !!built.warnings && built.warnings.length > 0,
    'ollama produces a warning',
    built.warnings,
  );
  assert(built.url === 'http://127.0.0.1:11434', 'ollama url default');
}

console.log('--- Shell quoting: paths with spaces ---');
{
  const cmd = ['/bin/llama-server', '-m', '/tmp/my models/llama.gguf'];
  const shell = formatCommandForShell(cmd);
  assert(
    /'[^']*my models[^']*'/.test(shell),
    'spaces in path get quoted',
    shell,
  );
}

console.log('--- Detection: returns array (no crash) ---');
detectRunners()
  .then((found) => {
    assert(
      Array.isArray(found),
      'detectRunners returned an array',
      found.length,
    );
    if (found.length > 0) {
      console.log(
        '     found:',
        found.map((r) => `${r.kind} @ ${r.path}`).join('\n            '),
      );
    } else {
      console.log('     (no runners installed — fine for CI)');
    }
  })
  .finally(() => {
    if (failed > 0) {
      console.error(`\n${failed} assertion(s) failed.`);
      process.exit(1);
    }
    console.log('\nAll runner-subsystem assertions passed.');
  });
