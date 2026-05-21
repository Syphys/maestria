# Maestria — architecture diagrams (PlantUML)

Every diagram of Maestria's AI / routing / sandbox subsystem, kept as
**PlantUML source** so it diffs in git like code. Organised by intent
(component / sequence / class / deployment) and composed via
`!include _includes/…iuml` so styling stays atomic.

## Folder layout

```
docs/diagrams/
├── README.md                       ← this file
├── _includes/                      ← shared bricks (`.iuml`)
│   ├── style.iuml                  ← Maestria palette + skinparams
│   ├── actors.iuml                 ← shared User / llama-server / sidecar
│   └── legend.iuml                 ← rung/prior/none + scheme legend
├── system-overview.puml            ← bird's-eye of the whole runtime
├── components/
│   ├── mcp-server.puml             ← MCP registry + transport + tools
│   ├── routing.puml                ← vector route vs R5 fallback
│   ├── characterization.puml       ← runner → tree → staircase → scorers
│   ├── sandbox.puml                ← slice 2d providers
│   ├── embedder.puml               ← managed-embedder lifecycle
│   └── freegen.puml                ← slice 7c probe
├── sequences/
│   ├── characterization-flow.puml  ← full characterise (one model)
│   ├── routing-flow.puml           ← models.route MCP call
│   ├── sandbox-execution.puml      ← per-OS isolation lifecycle
│   ├── embedder-startup.puml       ← ensureEmbedderReady
│   └── mcp-call.puml               ← models.run + launchedBy provenance
├── classes/
│   ├── signature.puml              ← BehavioralSignature shape
│   ├── competence-tree.puml        ← 9 branches × ~32 leaves taxonomy
│   └── sandbox-providers.puml      ← SandboxProvider ABC + impls
└── deployment.puml                 ← runtime processes + ports
```

## Rendering

Three ways, in order of friction:

1. **VS Code extension** (recommended for editing) —
   install `jebbs.plantuml`, then `Alt+D` on a `.puml` previews. No
   Java needed if you point the extension at the PlantUML server
   (`https://www.plantuml.com/plantuml`).
2. **CLI**, batch all diagrams to SVG/PNG:
   ```bash
   # one-shot install
   curl -fsSL -o plantuml.jar \
     https://github.com/plantuml/plantuml/releases/latest/download/plantuml.jar
   # render every .puml in this tree (skips _includes/*.iuml)
   java -jar plantuml.jar -tsvg -o "../svg" "docs/diagrams/**/*.puml"
   ```
3. **PlantUML web** — paste a `.puml` body into
   <https://www.plantuml.com/plantuml/uml/> (only for the
   self-contained ones; the ones using `!include` need local rendering).

## Conventions

- Every `.puml` starts with `!include _includes/style.iuml` so the
  palette / fonts stay consistent.
- Files using shared actors (User, llama-server, …) also
  `!include _includes/actors.iuml`.
- Routing diagrams that show the rung/prior/none vocabulary
  `!include _includes/legend.iuml` at the bottom.
- The scope is **AI subsystem only** — no TagSpaces-inherited file
  organiser plumbing, no perspective rendering, no general settings.
  Those have their own informal description in `CLAUDE.md` and the
  inline JSDoc.

## Source of truth

These diagrams describe the **current state on `develop`** as of the
commit they live in. When you change a wired-up flow (a new tool, a
new sandbox provider, a new routing knob), update the affected
`.puml` in the same commit — the diff stays auditable.

For the **prose** counterpart (vision + non-goals + tracker + MCP
dossier), see [`../../MODELS_HUB.md`](../../MODELS_HUB.md) (private,
gitignored — those are the maintainer's working notes).
