// Slice 2d — the default provider when `enableSandbox` is OFF in Settings.
// Refuses to run anything: the staircase translates the throw into an
// UNMEASURED verdict (D12 prior). Honesty over usefulness: we'd rather
// leave the leaves unmeasured than execute untrusted Python without the
// kernel-enforced boundary.
//
// Why a dedicated provider instead of just `if (!enableSandbox) return null`?
// Centralises the "you have to opt in" message, keeps the dispatch site
// (`index.ts`) symmetric across enabled/disabled, and gives the user a
// clean error trail when they try to run sandboxed items without opting in.

import { SandboxProvider, SandboxUnavailable } from './types';

export class UnsafeSandbox extends SandboxProvider {
  readonly kind = 'unsafe';

  async runPythonTests(): Promise<never> {
    throw new SandboxUnavailable(
      'opt-in disabled (Settings ▸ AI ▸ Routing ▸ Enable code-tests sandbox)',
    );
  }
}
