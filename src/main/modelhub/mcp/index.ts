/**
 * MCP module entry point.
 *
 * Wiring: importing this module's `start()` triggers:
 *   1. side-effect imports of every tool module (auto-register into the
 *      Tools Registry)
 *   2. lazy creation of the Bearer token if needed
 *   3. binding of the HTTP+SSE server on `127.0.0.1:41541`
 *
 * The lifecycle (auto-start at app boot, stop at quit) is hooked from
 * `src/main/modelhub/ipc.ts` so the toggle in Settings can drive it.
 */

// Side-effect imports — each module self-registers its tools.
import './tools/models';
import './tools/tags';
import './tools/description';
import './tools/hf';
import './tools/hardware';

export { start, stop, isRunning, getStatus } from './server';
export {
  getAutoStart,
  getOrCreateToken,
  regenerateToken,
  setAutoStart,
} from './token';
export { listTools } from './registry';
