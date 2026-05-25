# Contributing to Maestria

Thanks for considering a contribution! Maestria is an AGPL-3.0 fork of [TagSpaces](https://github.com/tagspaces/tagspaces), adapted into a local AI-model browser and orchestrator. The maintainer pool is small — concise, focused contributions land fastest.

## Before you start

- **Confirmed bug?** Open a [Bug report](https://github.com/Syphys/maestria/issues/new?template=bug_report.md).
- **Feature idea?** Open a [Feature request](https://github.com/Syphys/maestria/issues/new?template=feature_request.md) **first** — describe the use case before writing code. Saves both sides time if the answer is "out of scope" (see the template's scope section).
- **Question or "how do I…"?** Use [Discussions](https://github.com/Syphys/maestria/discussions), not Issues.
- **Security finding?** Do NOT open a public issue. See [SECURITY.md](SECURITY.md) — use GitHub's private vulnerability reporting.

## Development setup

See [README.md](README.md#-developer-guide) for the full toolchain. Quick summary:

```bash
git clone https://github.com/Syphys/maestria.git
cd maestria
git checkout develop
npm install
echo "KEY=$(openssl rand -hex 32)" > release/app/.env  # local WS server key
npm run dev
```

Branch from **`develop`**, not `main`. `main` tracks the latest stable release.

## What "good" contributions look like

- **Scope-respecting.** Maestria orchestrates **local llama-server processes** and exposes them via MCP. PRs that drift outside this scope (cloud-API integrations, generic file-organiser features, alternative engines like Ollama / LM Studio, chat UI) will likely be declined regardless of code quality. When in doubt, open the feature request first.
- **Targeted.** One concern per PR. Refactor-then-feature is two PRs. Unrelated cleanup goes in its own PR.
- **Tested where possible.** Unit tests live under `tests/unit/` (`npm run test-unit`). Renderer / e2e in `tests/e2e/` (`npm run test-playwright`). Add a test if you're fixing a regression — link it from the PR description.
- **Local checks pass.** Run before you push:
  ```bash
  npx tsc --noEmit       # TypeScript
  npm run lint           # ESLint
  npm run test-unit      # unit tests (fast)
  ```
  The pre-commit hook runs Prettier + the unit suite. A failing hook means the commit didn't go through — fix and re-stage.
- **Follow the repo's `CLAUDE.md` constraints.** That file documents architectural guard-rails (engine = llama-server only, no agent orchestration, sharded-model handling, etc.). It's required reading for anything touching `src/main/modelhub/`.

## Commit and PR style

- Commit subjects are short and prefixed: `feat(scope):`, `fix(scope):`, `chore(scope):`, `refactor(scope):`, `docs(scope):`. Scope is usually a folder name (`modelhub/runners`, `onboarding`, `welcome`, …).
- Subject ≤ 72 characters. Body explains **why** (not what — the diff shows what).
- One logical change per commit. Squash WIP commits before opening the PR.
- The PR template will ask you to summarise the change and confirm the local checks ran. Fill it in honestly — the maintainer trusts the checklist.

## Legal — DCO sign-off

Every commit must be signed off under the [Developer Certificate of Origin](https://developercertificate.org/). This attests that you have the right to submit your contribution under the project's AGPL-3.0 license — important for an AGPL fork that pulls from a trademark-distinct upstream.

Sign-off automatically with:

```bash
git commit -s -m "your message"
```

This appends a `Signed-off-by: Your Name <you@example.com>` trailer. Set your git identity once (`git config user.name`, `git config user.email`) and use the same email as your GitHub account.

PRs without sign-off on every commit will be flagged and asked to amend.

## License

By contributing, you agree your work is licensed under [AGPL-3.0](LICENSE.txt), the same license as the project. There is no contributor agreement that grants relicensing rights — Maestria stays AGPL-3.0 only.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Be kind, assume good faith, and stay on topic.
