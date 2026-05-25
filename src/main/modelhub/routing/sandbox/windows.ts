// Slice 2d — Windows sandbox provider. Real isolation via a Win32 Job
// Object created from PowerShell P/Invoke (no npm dependency, kernel32
// ships with Windows). The PS1 launcher (`win-job.ps1`) creates the
// Job, sets the limits (ActiveProcessLimit=1, ProcessMemoryLimit,
// KILL_ON_JOB_CLOSE), starts python.exe, assigns it to the Job, and
// replays stdout/stderr between marker lines so we can disentangle the
// child's output from the PS layer's own.
//
// See SECURITY-sandbox-2d.md §4 couche B for the rationale.

import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  SandboxProvider,
  type SandboxOptions,
  type SandboxResult,
  SandboxUnavailable,
} from './types';
import type { Spawner } from './posix';

const PS_STDOUT_BEGIN = '__SANDBOX_STDOUT_BEGIN__';
const PS_STDOUT_END = '__SANDBOX_STDOUT_END__';
const PS_STDERR_BEGIN = '__SANDBOX_STDERR_BEGIN__';
const PS_STDERR_END = '__SANDBOX_STDERR_END__';

/** Extract a block between two marker lines. Returns '' when absent. */
function extractBlock(haystack: string, begin: string, end: string): string {
  const i = haystack.indexOf(begin);
  if (i < 0) return '';
  const j = haystack.indexOf(end, i + begin.length);
  if (j < 0) return '';
  // +1 to skip the newline that follows the BEGIN marker
  return haystack.slice(i + begin.length + 1, j).trimEnd();
}

export class WindowsSandbox extends SandboxProvider {
  readonly kind = 'windows';

  constructor(
    private readonly opts: {
      /** Override the spawner — used by tests to mock child_process. */
      spawn?: Spawner;
      /** Override python.exe discovery — used by tests; if absent, lazy-probed. */
      pythonBin?: string;
      /**
       * Absolute path to `win-job.ps1`. Defaults to the one next to
       * this module. Tests can override to point at a fixture.
       */
      ps1Path?: string;
    } = {},
  ) {
    super();
  }

  private get spawner(): Spawner {
    return this.opts.spawn ?? (spawn as Spawner);
  }

  private get ps1Path(): string {
    if (this.opts.ps1Path) return this.opts.ps1Path;
    // In dev, `__dirname` sits next to win-job.ps1. In a packaged
    // build, webpack collapses everything into release/app/dist/main/
    // so the .ps1 is no longer alongside the JS — electron-builder
    // copies it to `process.resourcesPath/modelhub-sandbox/win-job.ps1`
    // via the extraResources entry in resources/builder.json. We
    // detect packaged-mode via `process.resourcesPath` (Electron-only
    // global, undefined in Node and tests) without importing electron
    // — keeps webpack's static analysis happy.
    const resourcesPath = (process as any).resourcesPath;
    if (typeof resourcesPath === 'string' && resourcesPath) {
      const candidate = path.join(
        resourcesPath,
        'modelhub-sandbox',
        'win-job.ps1',
      );
      if (fs.existsSync(candidate)) return candidate;
    }
    return path.join(__dirname, 'win-job.ps1');
  }

  async runPythonTests(
    code: string,
    tests: string,
    opts: SandboxOptions = {},
  ): Promise<SandboxResult> {
    if (process.platform !== 'win32') {
      throw new SandboxUnavailable('WindowsSandbox invoked off win32');
    }
    if (!fs.existsSync(this.ps1Path)) {
      throw new SandboxUnavailable(`win-job.ps1 not found at ${this.ps1Path}`);
    }
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const maxOutputBytes = opts.maxOutputBytes ?? 1_000_000;
    const memoryLimitBytes = opts.memoryLimitBytes ?? 512 * 1024 * 1024;

    const pythonBin = this.opts.pythonBin ?? (await this.findPython());

    let tmpDir: string;
    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestria-sandbox-'));
    } catch (e) {
      throw new SandboxUnavailable(`mkdtemp failed: ${(e as Error).message}`);
    }
    const scriptPath = path.join(tmpDir, 'script.py');
    // Note: unlike POSIX, the in-process import-guard preamble is less
    // valuable on Windows because the Job already prevents sub-processes
    // at the kernel level. We still inject a minimal guard for parity
    // and defense-in-depth against e.g. socket-based exfil.
    const preamble = `# Maestria sandbox preamble (Windows).
import builtins as _builtins
_BLOCKED = {'socket', 'subprocess', 'ctypes', 'multiprocessing', '_socket', '_subprocess', '_winapi'}
_real_import = _builtins.__import__
def _guarded_import(name, *args, **kwargs):
    top = name.split('.')[0] if name else ''
    if top in _BLOCKED:
        raise ImportError("module %r is blocked in the Maestria sandbox" % name)
    return _real_import(name, *args, **kwargs)
_builtins.__import__ = _guarded_import
`;
    const fullScript = preamble + '\n' + code + '\n' + tests + '\n';

    try {
      fs.writeFileSync(scriptPath, fullScript, 'utf-8');
    } catch (e) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      throw new SandboxUnavailable(
        `write script failed: ${(e as Error).message}`,
      );
    }

    try {
      return await this.spawnIsolated(
        pythonBin,
        scriptPath,
        tmpDir,
        timeoutMs,
        maxOutputBytes,
        memoryLimitBytes,
      );
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }

  private async findPython(): Promise<string> {
    // On Windows the python launcher `py` is the convention; fall back
    // to direct `python` / `python3`. We probe by importing a stdlib
    // module that's always there (`json`); a missing module is fatal
    // since we'd never be able to run anything either way.
    for (const bin of ['py', 'python', 'python3']) {
      try {
        await this.probeBinary(bin);
        return bin;
      } catch {
        // try next
      }
    }
    throw new SandboxUnavailable('no py/python/python3 on PATH');
  }

  private probeBinary(bin: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = this.spawner(bin, ['-c', 'print("ok")'], { shell: false });
      let stdout = '';
      const t = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        reject(new Error('probe timeout'));
      }, 2_000);
      child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
      child.on('close', (code) => {
        clearTimeout(t);
        if (code === 0 && stdout.trim() === 'ok') resolve();
        else reject(new Error(`probe exit ${code}`));
      });
      child.on('error', (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
  }

  /**
   * Spawn PowerShell with the launcher script. The launcher creates
   * the Job Object, arms the limits, starts python, and replays the
   * child's stdout/stderr between markers — we parse those markers out
   * to give the staircase a clean `{stdout, stderr}` to log.
   */
  private spawnIsolated(
    pythonBin: string,
    scriptPath: string,
    workDir: string,
    timeoutMs: number,
    maxOutputBytes: number,
    memoryLimitBytes: number,
  ): Promise<SandboxResult> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      // Give the PS layer ~1s margin over the wall-clock timeout so the
      // launcher's own WaitForExit times out first and we get a clean
      // 124 exit code (rather than a parent-side SIGKILL race).
      const innerTimeoutMs = Math.max(1_000, timeoutMs - 1_000);

      let child: ChildProcess;
      try {
        child = this.spawner(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            this.ps1Path,
            '-PythonExe',
            pythonBin,
            '-ScriptPath',
            scriptPath,
            '-TimeoutMs',
            String(innerTimeoutMs),
            '-WorkDir',
            workDir,
            '-MemoryLimitBytes',
            String(memoryLimitBytes),
          ],
          { shell: false },
        );
      } catch (e) {
        reject(new SandboxUnavailable(`spawn failed: ${(e as Error).message}`));
        return;
      }

      let raw = '';
      let stderrRaw = '';
      let reason: SandboxResult['reason'];

      const kill = () => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      };

      // Outer hard timeout — kicks in after the inner one if the PS
      // layer hangs unexpectedly. Adds 2s of headroom.
      const outerTimer = setTimeout(() => {
        if (!reason) reason = 'timeout';
        kill();
      }, timeoutMs + 2_000);

      const checkOverflow = () => {
        if (raw.length + stderrRaw.length > maxOutputBytes) {
          reason = 'output-overflow';
          kill();
        }
      };

      child.stdout?.on('data', (d: Buffer) => {
        raw += d.toString();
        checkOverflow();
      });
      child.stderr?.on('data', (d: Buffer) => {
        stderrRaw += d.toString();
        checkOverflow();
      });

      child.on('close', (code) => {
        clearTimeout(outerTimer);
        const durationMs = Date.now() - start;
        const stdout = extractBlock(raw, PS_STDOUT_BEGIN, PS_STDOUT_END);
        const stderr = extractBlock(raw, PS_STDERR_BEGIN, PS_STDERR_END);
        // 124 is the launcher's own "we terminated the Job on timeout".
        if (code === 124 && !reason) reason = 'timeout';
        const passNatural = !reason && code === 0;
        if (!passNatural && !reason) reason = 'exit-nonzero';
        resolve({
          pass: passNatural,
          stdout: stdout.slice(0, 4000),
          stderr: (stderr || stderrRaw).slice(0, 4000),
          durationMs,
          reason,
        });
      });

      child.on('error', (e) => {
        clearTimeout(outerTimer);
        reject(new SandboxUnavailable(`child error: ${(e as Error).message}`));
      });
    });
  }
}
