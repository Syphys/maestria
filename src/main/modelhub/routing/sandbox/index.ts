// Slice 2d — Sandbox dispatch. Picks the right provider based on
// `process.platform` AND the Settings opt-in toggle. Every other module
// in the codebase imports from here, never the per-OS providers
// directly — that keeps the platform branching localised.

import { PosixSandbox } from './posix';
import { UnsafeSandbox } from './unsafe';
import { WindowsSandbox } from './windows';
import { SandboxProvider } from './types';

export type GetSandboxOpts = {
  /** Settings toggle. When false, returns the UnsafeSandbox (which refuses). */
  enabled: boolean;
};

/**
 * Returns the active sandbox provider for the current runtime.
 *
 *  - `enabled: false` ⇒ `UnsafeSandbox` (refuses every call, item ⇒ UNMEASURED).
 *  - `enabled: true` on Linux/macOS ⇒ `PosixSandbox` (rlimits-isolated).
 *  - `enabled: true` on Windows     ⇒ `WindowsSandbox` (Job Object-isolated).
 *  - `enabled: true` on any other platform ⇒ `UnsafeSandbox` with a clear
 *    "OS not supported" message — fail-closed per SECURITY couche C.
 */
export function getSandbox(opts: GetSandboxOpts): SandboxProvider {
  if (!opts.enabled) return new UnsafeSandbox();
  if (process.platform === 'linux' || process.platform === 'darwin') {
    return new PosixSandbox();
  }
  if (process.platform === 'win32') {
    return new WindowsSandbox();
  }
  // Unknown OS: fail-closed.
  return new UnsafeSandbox();
}

// Public surface re-exports for callers that need the types directly.
export { SandboxProvider, SandboxUnavailable } from './types';
export type { SandboxOptions, SandboxResult } from './types';
export { PosixSandbox } from './posix';
export { WindowsSandbox } from './windows';
export { UnsafeSandbox } from './unsafe';
