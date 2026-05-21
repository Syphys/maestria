// Slice 2d — Sandbox providers (pure, seam-injectable).
// Verifies the fail-closed contract:
//   - UnsafeSandbox: always throws SandboxUnavailable
//   - getSandbox({enabled:false}): returns the UnsafeSandbox (no platform branch)
//   - PosixSandbox with mocked spawn: pass/fail/timeout/overflow paths,
//     SandboxUnavailable when python-probe fails
//   - dispatch picks the right module per platform
// No real `python` spawn — every test injects a mock spawner so the
// suite stays offline + fast.

import { describe, expect, test } from '@playwright/test';
import { EventEmitter } from 'events';
import {
  PosixSandbox,
  UnsafeSandbox,
  WindowsSandbox,
  SandboxUnavailable,
  getSandbox,
} from '../../../src/main/modelhub/routing/sandbox';

/**
 * Build a mock ChildProcess-shaped object whose lifecycle the test
 * drives explicitly. We re-implement the bits the providers touch:
 *  - `.stdout` / `.stderr` are EventEmitters
 *  - `.pid` is a fixed number
 *  - `.on('close' | 'error', cb)` registers handlers on the root emitter
 *  - `.kill(signal)` sets a flag (no-op otherwise)
 */
function makeChild() {
  const root = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  let killSignal = null;
  const child = {
    pid: 12345,
    stdout,
    stderr,
    killed: false,
    kill: (sig) => {
      killSignal = sig;
      child.killed = true;
    },
    on: (event, cb) => root.on(event, cb),
    // exposed for tests to drive the lifecycle
    _emitClose: (code) => root.emit('close', code),
    _emitStdout: (s) => stdout.emit('data', Buffer.from(s, 'utf-8')),
    _emitStderr: (s) => stderr.emit('data', Buffer.from(s, 'utf-8')),
    _emitError: (e) => root.emit('error', e),
    _killSignal: () => killSignal,
  };
  return child;
}

/**
 * Build a spawner that returns scripted children. `script` is a function
 * `(command, args) => MockChild` — the test arranges the lifecycle by
 * calling `_emitStdout` / `_emitClose` / `_emitError` on the returned
 * child. The probe call (`-c "import resource; print('ok')"`) is
 * handled separately via `probeOk` so each test doesn't have to script
 * it manually.
 */
function spawnerWith({ probeOk = true, run }) {
  return (cmd, args /*, opts */) => {
    const child = makeChild();
    // Detect the probe call: `python -c "import resource; print('ok')"`
    const isProbe =
      Array.isArray(args) &&
      args.length >= 2 &&
      args[0] === '-c' &&
      typeof args[1] === 'string' &&
      args[1].includes('print(');
    if (isProbe) {
      // The provider's `probeBinary` does `child.stdout.on('data', …)`
      // synchronously after spawn, and only later `child.on('close', …)`.
      // We deferred-emit so both handlers are registered first.
      setImmediate(() => {
        if (probeOk) {
          child._emitStdout('ok\n');
          child._emitClose(0);
        } else {
          child._emitClose(1);
        }
      });
      return child;
    }
    // Real run — defer to the test's scripted `run`.
    setImmediate(() => run(child));
    return child;
  };
}

describe('UnsafeSandbox — opt-in off, fail-closed (slice 2d)', () => {
  test('always throws SandboxUnavailable, never returns', async () => {
    const sb = new UnsafeSandbox();
    expect(sb.kind).toBe('unsafe');
    await expect(sb.runPythonTests('def solve(): pass', 'assert True')).rejects
      .toThrow(SandboxUnavailable);
  });
});

describe('getSandbox dispatch (slice 2d)', () => {
  test('enabled:false → UnsafeSandbox, regardless of platform', () => {
    const sb = getSandbox({ enabled: false });
    expect(sb.kind).toBe('unsafe');
  });

  test('enabled:true → real provider (kind matches platform family)', () => {
    const sb = getSandbox({ enabled: true });
    const plat = process.platform;
    if (plat === 'linux' || plat === 'darwin') {
      expect(sb.kind).toBe('posix');
    } else if (plat === 'win32') {
      expect(sb.kind).toBe('windows');
    } else {
      // Unsupported OS: fail-closed.
      expect(sb.kind).toBe('unsafe');
    }
  });
});

describe('PosixSandbox — kernel-enforced isolation (slice 2d)', () => {
  // The PosixSandbox refuses on win32 even if a test invokes it directly.
  const skipReason = process.platform === 'win32' ? 'PosixSandbox refuses on win32' : null;

  test('pass: child exits 0 → {pass:true}', async () => {
    if (skipReason) {
      const sb = new PosixSandbox({ pythonBin: 'python3' });
      await expect(sb.runPythonTests('', '')).rejects.toThrow(
        SandboxUnavailable,
      );
      return;
    }
    const sb = new PosixSandbox({
      pythonBin: 'python3',
      spawn: spawnerWith({
        run: (child) => {
          child._emitStdout('ran 1 assert\n');
          child._emitClose(0);
        },
      }),
    });
    const r = await sb.runPythonTests('def solve(x): return x*2', 'assert True');
    expect(r.pass).toBe(true);
    expect(r.reason).toBeUndefined();
    expect(r.stdout.includes('ran 1 assert')).toBe(true);
  });

  test('fail: child exits non-zero → {pass:false, reason:"exit-nonzero"}', async () => {
    if (skipReason) return;
    const sb = new PosixSandbox({
      pythonBin: 'python3',
      spawn: spawnerWith({
        run: (child) => {
          child._emitStderr('AssertionError: 2 != 3\n');
          child._emitClose(1);
        },
      }),
    });
    const r = await sb.runPythonTests('def solve(): return 2', 'assert solve() == 3');
    expect(r.pass).toBe(false);
    expect(r.reason).toBe('exit-nonzero');
    expect(r.stderr.includes('AssertionError')).toBe(true);
  });

  test('timeout: child runs past timeoutMs → killed, reason "timeout"', async () => {
    if (skipReason) return;
    const sb = new PosixSandbox({
      pythonBin: 'python3',
      spawn: spawnerWith({
        run: (child) => {
          // Never emits close — must be killed by the harness.
          // After kill, simulate the child finally closing.
          // The provider's setTimeout (50ms here) fires kill(); we then
          // manually emit close(124) to drain the promise.
          setTimeout(() => {
            if (child.killed) child._emitClose(124);
          }, 100);
        },
      }),
    });
    const r = await sb.runPythonTests('while True: pass', '', { timeoutMs: 50 });
    expect(r.pass).toBe(false);
    expect(r.reason).toBe('timeout');
  });

  test('overflow: total stdout+stderr > maxOutputBytes → killed, reason "output-overflow"', async () => {
    if (skipReason) return;
    const sb = new PosixSandbox({
      pythonBin: 'python3',
      spawn: spawnerWith({
        run: (child) => {
          // Pump > maxOutputBytes of stdout, then close.
          child._emitStdout('A'.repeat(2_000));
          setTimeout(() => {
            if (child.killed) child._emitClose(137); // 128+SIGKILL
          }, 10);
        },
      }),
    });
    const r = await sb.runPythonTests('print("X" * 10_000)', '', {
      maxOutputBytes: 1_000,
    });
    expect(r.pass).toBe(false);
    expect(r.reason).toBe('output-overflow');
  });

  test('SandboxUnavailable when python probe fails (fail-closed)', async () => {
    if (skipReason) return;
    const sb = new PosixSandbox({
      // omit pythonBin so the provider lazy-probes
      spawn: spawnerWith({ probeOk: false, run: () => {} }),
    });
    await expect(sb.runPythonTests('', '')).rejects.toThrow(SandboxUnavailable);
  });

  test('SandboxUnavailable when spawn errors during the real run', async () => {
    if (skipReason) return;
    const sb = new PosixSandbox({
      pythonBin: 'python3',
      spawn: spawnerWith({
        run: (child) => child._emitError(new Error('ENOENT')),
      }),
    });
    await expect(sb.runPythonTests('', '')).rejects.toThrow(SandboxUnavailable);
  });

  test('refuses to run on win32 (defensive)', async () => {
    if (process.platform !== 'win32') return; // posix path tested above
    const sb = new PosixSandbox({ pythonBin: 'python3' });
    await expect(sb.runPythonTests('', '')).rejects.toThrow(SandboxUnavailable);
  });
});

describe('WindowsSandbox — Job Object isolation (slice 2d)', () => {
  // Symmetric coverage to PosixSandbox; provider refuses off win32.
  test('refuses to run off win32 (defensive)', async () => {
    if (process.platform === 'win32') return;
    const sb = new WindowsSandbox({ pythonBin: 'py' });
    await expect(sb.runPythonTests('', '')).rejects.toThrow(SandboxUnavailable);
  });

  test('SandboxUnavailable when win-job.ps1 missing', async () => {
    if (process.platform !== 'win32') return; // off-platform refused above
    const sb = new WindowsSandbox({
      pythonBin: 'py',
      ps1Path: 'C:\\\\does\\\\not\\\\exist\\\\win-job.ps1',
    });
    await expect(sb.runPythonTests('', '')).rejects.toThrow(SandboxUnavailable);
  });
});
