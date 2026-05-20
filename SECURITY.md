# Security policy

Maestria is a local-only Electron application. It does not ship a network
service open to the public Internet; the optional MCP server it exposes
binds to `127.0.0.1` and is gated by a Bearer token. Despite this, file
parsers, IPC handlers, the runner-spawn pipeline and the MCP transport are
attack surface — please treat security findings here with the same care
you would any desktop application.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security reports.**

Use **GitHub's private vulnerability reporting** instead:

→ <https://github.com/Syphys/maestria/security/advisories/new>

This routes the report to the maintainers privately, lets us coordinate a
fix and a disclosure timeline, and credits you in the eventual public
advisory once the issue is patched.

If for some reason you cannot use that channel, open a normal issue
**without any vulnerability detail** — just say "I have a security
report, please reach out" — and a maintainer will follow up to set up a
private channel.

## What we ask of reporters

- Give us a reasonable window to investigate and ship a fix before any
  public disclosure. We will work with you on the timeline.
- Limit testing to your own installation — do not attempt to exploit
  third parties' Maestria instances.
- Provide enough detail to reproduce: OS, Maestria version (visible in
  About), reproduction steps, expected vs observed behaviour, and any
  proof-of-concept artefacts.

## Scope

In scope (please report):

- Arbitrary code execution from a crafted GGUF / safetensors / sidecar
  file, or from a malicious MCP `tools/call` payload.
- Path traversal / privilege escalation through `models.run`,
  `models.search`, sidecar writes, or runner-process spawning.
- MCP auth bypass (HTTP requests succeeding without the configured
  Bearer token).
- Information disclosure from HF metadata / sidecar files / `~/.tagspaces/`
  beyond what the UI documents.

Out of scope (please do NOT report):

- Resource exhaustion by feeding Maestria a deliberately enormous local
  folder — the app is a local tool, the user controls the input.
- Crashes from corrupt files that do not lead to code execution.
- Findings in upstream code that we have not modified (TagSpaces /
  llama-server / models) — please report those to the relevant project.
- Anything that requires the attacker to already control the user's
  machine.

## Upstream

Maestria is an independent fork of [TagSpaces](https://github.com/tagspaces/tagspaces).
Vulnerabilities in unmodified upstream code should also be reported to
TagSpaces GmbH per their own policy.
