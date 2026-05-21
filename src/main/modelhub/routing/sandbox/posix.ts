// Slice 2d — POSIX (Linux + macOS) sandbox provider. Real isolation via
// `resource.setrlimit` inside the Python child (kernel-enforced) plus a
// disposable workdir, an emptied env, and a process-group kill on
// timeout / output overflow. See SECURITY-sandbox-2d.md §4 couche B for
// the full rationale per rlimit.

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

/**
 * Python preamble run BEFORE the model's `code` is imported / `tests`
 * is exercised. Establishes the in-process limits AND a tiny import
 * guard (defense in depth — the real boundary is the rlimits below).
 *
 * The preamble is written verbatim into the on-disk script so the
 * limits are armed by the child itself before any model-authored line
 * runs. Caps (`MEM`, `CPU`, …) are passed as Python expressions so the
 * harness can override them per-call without re-templating the script.
 */
/** Sentinel exit code: child couldn't establish the kernel boundary.
 *  Parent maps to SandboxUnavailable ⇒ UNMEASURED (D12). 78 = EX_CONFIG
 *  on BSD/macOS, conventionally "configuration error". */
const SANDBOX_RLIMIT_FAIL_EXIT = 78;

function buildPreamble(opts: {
  memoryLimitBytes: number;
  cpuLimitSeconds: number;
}): string {
  return `# Maestria sandbox preamble — kernel-enforced limits.
# Importing 'resource' MUST succeed on a real POSIX Python; if it does
# not we cannot establish the boundary and the harness will surface a
# SandboxUnavailable to the caller (see types.ts).
#
# Audit fix #2 (2026-05-21): align with DECISIONS.md Dαα §3 fail-closed.
# Any failure to set a STRICT rlimit ⇒ exit with sentinel ${SANDBOX_RLIMIT_FAIL_EXIT};
# the parent maps that to SandboxUnavailable ⇒ UNMEASURED. The previous
# code swallowed setrlimit errors with \`except: pass\`, which silently
# ran the model with weaker limits than the threat-model promises.
import resource as _resource, sys as _sys

def _strict_setrlimit(label, which, soft, hard=None):
    """STRICT: failure ⇒ child exits 78, parent surfaces SandboxUnavailable."""
    try:
        _resource.setrlimit(which, (soft, soft if hard is None else hard))
    except Exception as _e:
        _sys.stderr.write(
            "MAESTRIA_SANDBOX_RLIMIT_FAIL:" + label + ":" + str(_e) + chr(10)
        )
        _sys.stderr.flush()
        _sys.exit(${SANDBOX_RLIMIT_FAIL_EXIT})

# T2/T7 — block any new process (kernel-enforced). STRICT.
# RLIMIT_NPROC is per-UID on Linux: pin it at the current count so this
# user cannot fork anymore, without affecting their other processes.
try:
    _cur_nproc, _ = _resource.getrlimit(_resource.RLIMIT_NPROC)
except Exception as _e:
    _sys.stderr.write("MAESTRIA_SANDBOX_RLIMIT_FAIL:NPROC_READ:" + str(_e) + chr(10))
    _sys.stderr.flush()
    _sys.exit(${SANDBOX_RLIMIT_FAIL_EXIT})
_strict_setrlimit("NPROC", _resource.RLIMIT_NPROC, _cur_nproc)

# T6 — memory cap (~512 MiB by default). AT LEAST ONE of AS / DATA
# must succeed (RLIMIT_AS is unreliable on macOS so DATA is the
# documented fallback). If BOTH fail, fail-closed.
_MEM = ${opts.memoryLimitBytes}
_mem_set = False
for _which, _label in ((_resource.RLIMIT_AS, "AS"), (_resource.RLIMIT_DATA, "DATA")):
    try:
        _resource.setrlimit(_which, (_MEM, _MEM))
        _mem_set = True
    except Exception:
        continue
if not _mem_set:
    _sys.stderr.write("MAESTRIA_SANDBOX_RLIMIT_FAIL:MEM:no AS/DATA available" + chr(10))
    _sys.stderr.flush()
    _sys.exit(${SANDBOX_RLIMIT_FAIL_EXIT})

# T1 — CPU seatbelt. Best-effort: the parent enforces a wall-clock
# timeout anyway, so a missing RLIMIT_CPU is a degraded but acceptable
# defense layer (cf. SECURITY-sandbox-2d.md §5 residual).
try:
    _resource.setrlimit(_resource.RLIMIT_CPU, (${opts.cpuLimitSeconds}, ${opts.cpuLimitSeconds}))
except Exception:
    pass

# T4 — no filesystem writes (file size cap = 0). STRICT.
_strict_setrlimit("FSIZE", _resource.RLIMIT_FSIZE, 0)

# Defense in depth — block import of network/process/native modules.
# Honest: trivially bypassable via __class__/getattr tricks; the rlimits
# above are the actual boundary. Still useful to fail-fast on naive
# malicious payloads (T5/T7 surface reduction).
_BLOCKED = {'socket', 'subprocess', 'ctypes', 'multiprocessing', '_socket', '_subprocess', '_winapi'}
import builtins as _builtins
_real_import = _builtins.__import__
def _guarded_import(name, *args, **kwargs):
    top = name.split('.')[0] if name else ''
    if top in _BLOCKED:
        raise ImportError("module %r is blocked in the Maestria sandbox" % name)
    return _real_import(name, *args, **kwargs)
_builtins.__import__ = _guarded_import

# Yield control to the model-authored code below.
`;
}

/**
 * Test seam — the spawner the provider uses. Production code uses
 * Node's built-in `spawn`; unit tests inject a mock so they can drive
 * the lifecycle (timeouts, output overflow, exit codes) without
 * actually invoking Python.
 */
export type Spawner = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export class PosixSandbox extends SandboxProvider {
  readonly kind = 'posix';

  constructor(
    private readonly opts: {
      /** Override the spawner — used by tests to mock child_process. */
      spawn?: Spawner;
      /** Override Python discovery — used by tests; if absent, lazy-probed. */
      pythonBin?: string;
    } = {},
  ) {
    super();
  }

  private get spawner(): Spawner {
    return this.opts.spawn ?? (spawn as Spawner);
  }

  async runPythonTests(
    code: string,
    tests: string,
    opts: SandboxOptions = {},
  ): Promise<SandboxResult> {
    if (process.platform === 'win32') {
      // Defensive — the dispatch in index.ts shouldn't get us here, but
      // we don't want a Linux-only setsid call to silently no-op on win32.
      throw new SandboxUnavailable('PosixSandbox invoked on win32');
    }
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const maxOutputBytes = opts.maxOutputBytes ?? 1_000_000;
    const memoryLimitBytes = opts.memoryLimitBytes ?? 512 * 1024 * 1024;
    const cpuLimitSeconds = opts.cpuLimitSeconds ?? 10;

    const pythonBin = this.opts.pythonBin ?? (await this.findPython());

    // Workdir jetable — `mkdtemp` is sync, no race.
    let tmpDir: string;
    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestria-sandbox-'));
    } catch (e) {
      throw new SandboxUnavailable(`mkdtemp failed: ${(e as Error).message}`);
    }
    const scriptPath = path.join(tmpDir, 'script.py');
    const preamble = buildPreamble({ memoryLimitBytes, cpuLimitSeconds });
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
      );
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }

  /**
   * Locate a Python interpreter that has the `resource` module
   * available (i.e. a real POSIX build). Tries `python3` then `python`.
   * Throws `SandboxUnavailable` if neither works.
   */
  private async findPython(): Promise<string> {
    for (const bin of ['python3', 'python']) {
      try {
        await this.probeBinary(bin);
        return bin;
      } catch {
        // try next
      }
    }
    throw new SandboxUnavailable('no python3/python with resource module');
  }

  /**
   * Quick capability probe: `python -c "import resource; print('ok')"`.
   * Used both at startup and by tests; bounded to 2 s.
   */
  private probeBinary(bin: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = this.spawner(bin, ['-c', 'import resource; print("ok")'], {
        shell: false,
      });
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
   * Spawn python with `-I -S -B` (isolated mode: ignores PYTHON*, no
   * site, no `.pyc`), an emptied env (minimal PATH only), the temp
   * workdir as cwd, and `detached:true` so the child gets its own
   * process group — that's what lets us `kill(-pgid)` on timeout and
   * take down any descendants the model might have managed to fork
   * before the NPROC limit kicked in.
   */
  private spawnIsolated(
    pythonBin: string,
    scriptPath: string,
    cwd: string,
    timeoutMs: number,
    maxOutputBytes: number,
  ): Promise<SandboxResult> {
    return new Promise((resolve, reject) => {
      const env: NodeJS.ProcessEnv = {
        PATH: '/usr/bin:/bin:/usr/local/bin',
        LANG: 'C',
      };
      const start = Date.now();
      let child: ChildProcess;
      try {
        child = this.spawner(pythonBin, ['-I', '-S', '-B', scriptPath], {
          shell: false,
          cwd,
          env,
          detached: true,
        });
      } catch (e) {
        reject(new SandboxUnavailable(`spawn failed: ${(e as Error).message}`));
        return;
      }

      let stdout = '';
      let stderr = '';
      let reason: SandboxResult['reason'];

      const kill = () => {
        try {
          // detached:true on POSIX gives us a process group leader at
          // -pid. Sending SIGKILL to -pid reaps the whole group.
          if (typeof child.pid === 'number') {
            try {
              process.kill(-child.pid, 'SIGKILL');
            } catch {
              child.kill('SIGKILL');
            }
          } else {
            child.kill('SIGKILL');
          }
        } catch {
          /* already gone */
        }
      };

      const timer = setTimeout(() => {
        reason = 'timeout';
        kill();
      }, timeoutMs);

      const checkOverflow = () => {
        if (stdout.length + stderr.length > maxOutputBytes) {
          reason = 'output-overflow';
          kill();
        }
      };

      child.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString();
        checkOverflow();
      });
      child.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString();
        checkOverflow();
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        const durationMs = Date.now() - start;
        // Audit fix #2 — sentinel exit 78 means the preamble couldn't
        // arm the kernel limits. Per Dαα §3 fail-closed: surface as
        // SandboxUnavailable so the caller marks the item UNMEASURED,
        // NEVER as a real pass / fail. stderr should carry a
        // `MAESTRIA_SANDBOX_RLIMIT_FAIL:<label>:<message>` line.
        if (code === SANDBOX_RLIMIT_FAIL_EXIT && !reason) {
          const tail = stderr
            .split('\n')
            .filter((l) => l.startsWith('MAESTRIA_SANDBOX_RLIMIT_FAIL:'))
            .slice(-1)[0]
            ?.replace('MAESTRIA_SANDBOX_RLIMIT_FAIL:', '');
          reject(
            new SandboxUnavailable(
              `rlimit setup failed in child: ${tail ?? 'unknown'}`,
            ),
          );
          return;
        }
        const passNatural = !reason && code === 0;
        if (!passNatural && !reason) reason = 'exit-nonzero';
        resolve({
          pass: passNatural,
          stdout: stdout.slice(0, 4000),
          stderr: stderr.slice(0, 4000),
          durationMs,
          reason,
        });
      });

      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new SandboxUnavailable(`child error: ${(e as Error).message}`));
      });
    });
  }
}
