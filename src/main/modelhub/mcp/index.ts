/**
 * MCP module entry point.
 *
 * Wiring: importing this module's `start()` triggers:
 *   1. side-effect imports of every tool module (auto-register into the
 *      Tools Registry)
 *   2. lazy creation of the user Bearer token if needed
 *   3. binding of the HTTP+SSE server on `127.0.0.1:41541`
 *
 * The lifecycle (auto-start at app boot, stop at quit) is hooked from
 * `src/main/modelhub/ipc.ts` so the toggle in Settings can drive it.
 */

// Side-effect imports — each module self-registers its tools at load.
// Order is irrelevant; the registry throws on duplicate names so any
// accidental redefinition surfaces loudly.
import './tools/models';
import './tools/route';
import './tools/tags';
import './tools/description';
import './tools/hardware';
import './tools/characterize';
import './tools/logs';
import './tools/meta';
import './tools/discovery';
import './tools/runners';
import './tools/configs';

export { start, stop, isRunning, getStatus } from './server';
export {
  getAdminToken,
  getAutoStart,
  getOrCreateAdminToken,
  getOrCreateToken,
  regenerateAdminToken,
  regenerateToken,
  revokeAdminToken,
  setAutoStart,
} from './token';
export { listTools } from './registry';
