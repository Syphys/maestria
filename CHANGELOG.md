# Changelog

All notable changes to **Maestria** are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning is
[SemVer](https://semver.org/) — pre-1.0 releases (`0.x`) reserve the
right to make breaking changes between minor versions.

Maestria is an independent fork of [TagSpaces](https://github.com/tagspaces/tagspaces).
Pre-fork history (TagSpaces ≤ 6.11.4) is not duplicated here — see
upstream <https://www.tagspaces.org/whatsnew/> for that lineage.

## [Unreleased]

### Added — Vector routing (Phase 7)

- `models.route` MCP tool: pick the best local model for a query by
  projecting the query onto a 9-branch × 32-leaf competence tree, scoring
  every characterised model on the same tree, and ranking by competence +
  live memory-fit + already-running bonus.
- Competence characterisation pipeline: deterministic R5 axes (code,
  math, reasoning, multistep, factual, instruction, longctx, lang,
  meta, tooluse, robustness, calibration, summarization, informatics) +
  CAT-style staircase climb per leaf, Beta-Laplace pass-rate smoothing.
- Managed embedder lifecycle: user picks a `.gguf` embedder file in
  Settings ▸ AI ▸ Routing, Maestria launches `llama-server --embedding`
  itself (idempotent, concurrent-safe, fail-soft fallback to R5).
- Free-generation probe: optional embedder-only "topic coverage" signal
  blended (α=0.7 / β=0.3) into the routing score on top of the
  deterministic competence.
- "Arbre de compétence" UI: collapsible per-leaf radar under the R5
  radar in the Inférence tab, with copyable plain-text breakdown.
- "Force re-characterize" bulk toggle in the characterisation panel.

### Changed

- `chat.ts` defaults raised so multistep characterisation prompts no
  longer hit early-abort on slow local models: per-attempt timeout
  120 s → 240 s, max-tokens 1024 → 2048. AbortError (request timeout)
  is no longer retried — retrying just waits for the same slow
  generation again.
- R5 radar polished: fr/en/zh collapsed into a single `lang` axis for
  display, `qcm` aptitude shown as a display-only axis (never enters
  routing), click-to-drill-down opens the full per-axis responses.
- Auto-update check on app boot disabled (the upstream feed would
  advertise TagSpaces versions which do not include Maestria's changes).

### Removed

- In-app chat surface — the conversation belongs to external clients
  (Claude Desktop, Cursor, deer-flow). Maestria launches models and
  opens the native llama-server web UI in the user's browser.
- Agent orchestration scaffolding (`AgentConfig`, `RunningAgentsPanel`,
  `agents.*` MCP tools) — Maestria orchestrates *models*, not agents.
  Archived on branch `archive/agents`.
- Ollama / LM Studio runner abstractions — `llama-server` is the only
  supported runner.

### Fixed

- MCP config snippet: emit `type: 'sse'` (canonical MCP spec key)
  instead of `transport: 'sse'`. Previously every standard MCP client
  silently ignored the snippet (no `models.*` tools registered).
- Sharded models: `models.run` and sidecar IO consistently route
  through the canonical shard 1 path, so a model split into N files
  is treated as one logical entity throughout.
- Runner config form state leak between consecutive edits.
- Runner registry: empty-string `id` field would let new manually-added
  runners overwrite each other.

[Unreleased]: https://github.com/Syphys/maestria/commits/develop
