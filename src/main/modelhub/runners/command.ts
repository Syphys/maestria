/**
 * Build the command-line invocation for a given runner + model + params.
 *
 * Each runner kind has its own flag spelling, so we keep a small dispatch
 * table here. The output is `[binary, ...args]` so it's both:
 *  - directly spawnable via child_process.spawn (no shell, no quoting bugs)
 *  - and trivially serializable to a copy-paste-friendly string with proper
 *    quoting (see `formatCommandForShell`).
 *
 * `safetensors` files: only llama.cpp/ik_llama.cpp can ingest them via the
 * --hf flag or after conversion. For the MVP we still build a command but
 * tag it with a warning the UI can surface.
 */

import { RunnerConfig, RunParams } from '../../../renderer/modelhub/types';

export interface BuildCommandResult {
  command: string[];
  /** Server URL the user can hit, when applicable. */
  url?: string;
  warnings?: string[];
}

function buildLlamaCpp(
  runner: RunnerConfig,
  modelPath: string,
  params: RunParams,
): BuildCommandResult {
  const args: string[] = ['-m', modelPath];
  if (typeof params.ngl === 'number') {
    args.push('--n-gpu-layers', String(params.ngl));
  }
  if (typeof params.ctx === 'number') {
    args.push('-c', String(params.ctx));
  }
  if (typeof params.threads === 'number') {
    args.push('-t', String(params.threads));
  }
  if (typeof params.batchSize === 'number') {
    args.push('-b', String(params.batchSize));
  }
  if (params.flashAttn) {
    args.push('--flash-attn');
  }
  if (params.mlock) {
    args.push('--mlock');
  }
  // llama-server wants --port; llama-cli has no server.
  const isServer = runner.path.toLowerCase().includes('server');
  if (isServer) {
    args.push('--host', '127.0.0.1', '--port', String(params.port ?? 8080));
  }
  return {
    command: [runner.path, ...args],
    url: isServer ? `http://127.0.0.1:${params.port ?? 8080}` : undefined,
  };
}

function buildOllama(
  runner: RunnerConfig,
  modelPath: string,
  _params: RunParams,
): BuildCommandResult {
  // Ollama doesn't take a raw GGUF path on the CLI; the model has to be
  // registered first via `ollama create -f Modelfile`. For the MVP we
  // surface a usable command and a warning. Phase 4 will automate the
  // Modelfile generation.
  return {
    command: [runner.path, 'serve'],
    url: 'http://127.0.0.1:11434',
    warnings: [
      `Ollama can't load a raw .gguf path directly. Register it first: \`ollama create my-model -f Modelfile\` where Modelfile contains \`FROM ${modelPath}\`. Then run \`ollama run my-model\`.`,
    ],
  };
}

function buildKoboldcpp(
  runner: RunnerConfig,
  modelPath: string,
  params: RunParams,
): BuildCommandResult {
  const args: string[] = [
    '--model',
    modelPath,
    '--port',
    String(params.port ?? 5001),
  ];
  if (typeof params.ngl === 'number' && params.ngl > 0) {
    args.push('--gpulayers', String(params.ngl));
  }
  if (typeof params.ctx === 'number') {
    args.push('--contextsize', String(params.ctx));
  }
  if (typeof params.threads === 'number') {
    args.push('--threads', String(params.threads));
  }
  return {
    command: [runner.path, ...args],
    url: `http://127.0.0.1:${params.port ?? 5001}`,
  };
}

function buildLmStudio(
  runner: RunnerConfig,
  modelPath: string,
  _params: RunParams,
): BuildCommandResult {
  // `lms` CLI loads an already-imported model. We point it at the file and
  // let LM Studio handle the rest. The user must have imported the model
  // into LM Studio's library at least once.
  return {
    command: [runner.path, 'load', modelPath],
    url: 'http://127.0.0.1:1234',
    warnings: [
      'LM Studio CLI requires the model to be in its library. If "lms load" fails, import the file via the LM Studio app once first.',
    ],
  };
}

export function buildCommand(
  runner: RunnerConfig,
  modelPath: string,
  params: RunParams,
): BuildCommandResult {
  switch (runner.kind) {
    case 'llama.cpp':
    case 'ik_llama.cpp':
      return buildLlamaCpp(runner, modelPath, params);
    case 'ollama':
      return buildOllama(runner, modelPath, params);
    case 'koboldcpp':
      return buildKoboldcpp(runner, modelPath, params);
    case 'lm-studio':
      return buildLmStudio(runner, modelPath, params);
    case 'custom':
    default:
      // Unknown kind: pass model as the first arg and hope the user knows.
      return { command: [runner.path, modelPath] };
  }
}

/**
 * Quote the command for a shell so the user can paste it. Uses platform
 * conventions: PowerShell-friendly on Windows (single quotes for paths
 * with spaces), POSIX shell quoting elsewhere.
 */
export function formatCommandForShell(cmd: string[]): string {
  const isWin = process.platform === 'win32';
  return cmd
    .map((arg) => {
      if (!arg) return '""';
      if (isWin) {
        // PowerShell single-quote rules: any ' becomes ''.
        if (/[\s"'`$&|;()<>]/.test(arg)) {
          return `'${arg.replace(/'/g, "''")}'`;
        }
        return arg;
      }
      if (/[\s"'`$&|;()<>\\!]/.test(arg)) {
        return `'${arg.replace(/'/g, `'\\''`)}'`;
      }
      return arg;
    })
    .join(' ');
}
