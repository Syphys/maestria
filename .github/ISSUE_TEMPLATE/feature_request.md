---
name: Feature request
about: Suggest a new capability or improvement for Maestria
title: ''
labels: enhancement
assignees: ''
---

**Use case**
What are you trying to do that Maestria doesn't support today? Describe the workflow, not the implementation — e.g. "I want to launch model X with custom flags from an MCP call", not "add a `customArgs` field to the MCP tool".

**Proposed solution (optional)**
If you have one in mind. Otherwise leave blank — implementation discussion is welcome but not required.

**Alternatives considered**
Other tools / workarounds you've tried, and why they fell short for this use case.

**Scope check**
Maestria is **specifically** a local AI-model browser and orchestrator. Feature requests that fit:
- Better model browsing / metadata / tagging / search
- Improved llama.cpp / llama-server integration
- New MCP tools or transports
- Hardware autotune / routing improvements
- Onboarding / UX for the model-library workflow

Out of scope (likely "won't fix"):
- General file-organiser features that don't relate to AI models (TagSpaces upstream covers those)
- Cloud-API integrations (OpenAI, Anthropic, etc.) — Maestria is local-first by design
- Adding back the chat UI / agent orchestration (explicitly removed; see `CLAUDE.md`)
- Ollama or LM Studio support — only llama-server is supported

**Additional context**
Mockups, links to similar features in other tools, references to relevant llama.cpp / MCP spec sections, etc.
