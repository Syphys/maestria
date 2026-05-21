# Maestria — architecture diagrams (PlantUML)

Full UML conceptual space of Maestria's AI / routing / sandbox / MCP /
embedder / characterization stack. PlantUML source kept in git so it
diffs like code. Strictly DRY: every class / actor / component is
**defined once** in a partial under `_includes/`, and referenced from
every composer that needs it via `!include`.

## Folder layout

```
docs/diagrams/
├── README.md                         ← this file
├── _includes/                        ← DRY partials — definitions live ONLY here
│   ├── style.iuml                    ← palette + skinparams
│   ├── actors.iuml                   ← generic shared actors (component-shape)
│   ├── legend.iuml                   ← rung/prior/none + scoring_scheme
│   ├── classes/                      ← class / type definitions
│   │   ├── routing-types.iuml        ← Signature / BehavioralSignature / …
│   │   ├── competence-tree.iuml      ← CompetenceBranch + COMPETENCE_TREE
│   │   ├── sandbox-types.iuml        ← SandboxProvider ABC + Result/Options/Unavailable
│   │   ├── sandbox-unsafe.iuml       ← UnsafeSandbox
│   │   ├── sandbox-posix.iuml        ← PosixSandbox + Spawner
│   │   ├── sandbox-windows.iuml      ← WindowsSandbox + win-job.ps1 ref
│   │   └── sandbox-index.iuml        ← GetSandbox factory
│   ├── components/                   ← component-level reusable stacks
│   │   ├── mcp-stack.iuml
│   │   ├── routing-stack.iuml
│   │   ├── characterization-stack.iuml
│   │   ├── sandbox-stack.iuml
│   │   ├── embedder-stack.iuml
│   │   └── ui-stack.iuml
│   ├── sequences/
│   │   └── participants.iuml         ← every recurring sequence participant
│   ├── usecase/
│   │   └── actors.iuml               ← use-case-style actors
│   └── states/                       ← (reserved for future shared states)
│
├── system-overview.puml              ← bird's-eye composite
├── deployment.puml                   ← runtime processes + ports
│
├── components/                       ← UML component diagrams
│   ├── mcp-server.puml
│   ├── routing.puml
│   ├── characterization.puml
│   ├── sandbox.puml
│   ├── embedder.puml
│   └── freegen.puml
│
├── sequences/                        ← UML sequence diagrams
│   ├── characterization-flow.puml
│   ├── routing-flow.puml
│   ├── sandbox-execution.puml
│   ├── embedder-startup.puml
│   └── mcp-call.puml
│
├── classes/                          ← UML class diagrams (thin composers)
│   ├── signature.puml
│   ├── competence-tree.puml
│   └── sandbox-providers.puml
│
├── usecase/                          ← UML use case diagrams
│   └── users.puml
│
├── states/                           ← UML state machine diagrams
│   ├── signature-lifecycle.puml
│   ├── embedder-process.puml
│   ├── sandbox-dispatch.puml
│   └── runner-process.puml
│
├── activities/                       ← UML activity diagrams
│   ├── routing-decision.puml
│   ├── characterization-escalation.puml
│   └── sandbox-kill-paths.puml
│
├── objects/                          ← UML object diagrams (instances)
│   ├── characterized-model.puml
│   └── running-models-panel.puml
│
├── packages/                         ← UML package diagram
│   └── modelhub.puml
│
├── c4/                               ← (bonus) C4 model
│   └── context.puml
│
└── mockups/                          ← (bonus) Salt UI mockups
    └── inference-tab.puml
```

## UML coverage

| UML diagram type | Folder | Files | Notes |
|---|---|---|---|
| Class | `classes/` | 3 | composers reference shared `_includes/classes/*.iuml` |
| Component | `components/` + `system-overview.puml` | 7 | reference shared `_includes/components/*.iuml` |
| Sequence | `sequences/` | 5 | reference `_includes/sequences/participants.iuml` |
| State machine | `states/` | 4 | signature, embedder, sandbox dispatch, runner |
| Activity | `activities/` | 3 | routing decision, char escalation, sandbox kill paths |
| Use case | `usecase/` | 1 | User + MCP client actions |
| Object | `objects/` | 2 | snapshot of a characterized model + RunningModelsPanel |
| Package | `packages/` | 1 | modelhub.* TS package dependency graph |
| Deployment | root | 1 | processes + ports + filesystem |
| **Bonus — C4 Context** | `c4/` | 1 | Maestria as a black box + external systems |
| **Bonus — Salt mockup** | `mockups/` | 1 | Inférence tab UI |

UML diagram types intentionally **not** covered (low value for this codebase):

- Communication diagram — redundant with sequence
- Timing diagram — no hard timing constraints we model
- Interaction overview — too meta for v0
- Profile diagram — we use `<<stereotype>>` ad-hoc, no dedicated profile
- Composite structure — covered well enough by `components/mcp-server.puml`

## Rendering

1. **VS Code extension** (recommended) — install `jebbs.plantuml`,
   then `Alt+D` on a `.puml`.
2. **CLI** to batch SVG/PNG for the whole tree:
   ```bash
   curl -fsSL -o plantuml.jar \
     https://github.com/plantuml/plantuml/releases/latest/download/plantuml.jar
   java -jar plantuml.jar -tsvg -o "../svg" "docs/diagrams/**/*.puml"
   ```
3. **PlantUML web** — paste a SINGLE `.puml` body into
   <https://www.plantuml.com/plantuml/uml/>. ⚠️ Files using `!include`
   relative paths only render locally (the web service can't reach
   our `_includes/`).

## Conventions

- Every `.puml` starts with `!include _includes/style.iuml`.
- **Each class / type / shape / actor / component is defined ONCE**,
  in a partial under `_includes/`. Composers `!include` the partial —
  never redeclare. Editing a field is a one-line change that
  propagates to every composer that references it.
- Composers are thin — includes + relationships + notes. The notes
  are the only thing they carry that doesn't live in a partial.
- Aliases in partials are stable (e.g. `as PKG_SBX_TYPES`,
  `as CMP_T_MODELS`). If you rename one, every composer breaks
  visibly at the next render — that's intentional.
- Scope = AI subsystem only. No TagSpaces-inherited file organiser
  plumbing, no perspective rendering, no general settings —
  documented in `CLAUDE.md` and the inline JSDoc instead.

## Source of truth

Diagrams describe the **current state on `develop`** at the commit
they live in. When you change a wired-up flow (a new tool, a new
sandbox provider, a new routing knob), update the affected partial
under `_includes/` in the same commit — that automatically updates
every composer that references it.

Prose counterpart: [`../../MODELS_HUB.md`](../../MODELS_HUB.md)
(private, gitignored — maintainer's working notes).
