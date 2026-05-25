## Summary

<!-- One or two sentences: what does this PR change, and why. -->

## Type

<!-- Tick the one that applies. -->

- [ ] Bug fix (`fix(scope): …`)
- [ ] New feature (`feat(scope): …`)
- [ ] Refactor / cleanup (`refactor(scope): …`)
- [ ] Docs / scripts (`docs(scope): …` / `chore(scope): …`)
- [ ] Other:

## Linked issue

<!-- "Fixes #123" or "Related to #123". Use "Fixes" to auto-close the issue on merge. -->

Fixes #

## Scope check

<!-- See CONTRIBUTING.md and the feature_request.md scope section. -->

- [ ] This change fits Maestria's stated scope (local llama-server orchestration, model browsing/metadata, MCP, runner config). If unsure, link to the feature-request issue where scope was confirmed.

## Local checks

<!-- All four must pass before opening the PR. The pre-commit hook covers
     prettier + the unit suite; the others are on you. -->

- [ ] `npx tsc --noEmit` — 0 errors
- [ ] `npm run lint` — 0 errors
- [ ] `npm run test-unit` — all passing
- [ ] Manual smoke test for UI changes (describe below)

## Manual test plan

<!-- For UI / runtime changes, describe what you actually clicked through
     to confirm the change works. Screenshots welcome. Skip if pure
     internal refactor with full test coverage. -->

## Sign-off

- [ ] All commits are signed off (`git commit -s …`). See CONTRIBUTING.md.

## Notes for the reviewer

<!-- Anything worth flagging: gotchas, follow-up work split into a
     separate issue, why a particular approach was chosen over alternatives,
     dependencies on other PRs, etc. -->
