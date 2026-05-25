---
name: Bug report
about: Something broken or misbehaving in Maestria
title: ''
labels: bug
assignees: ''
---

**What happened**
A clear description of the bug — what did you do, what did Maestria do.

**Expected behaviour**
What you thought would happen instead.

**Steps to reproduce**
1.
2.
3.

**Screenshots / logs**
- Screenshots of the UI when relevant.
- Main-process logs from the terminal where you launched Maestria (or `Help → Show logs` if you installed the packaged build).
- For runner / llama.cpp issues: copy the server log accessible from the Inférence tab's log button.

**Environment**
- OS: [Windows 11 / macOS 14 / Ubuntu 24.04 / …]
- Maestria version: [About dialog, e.g. `0.1.0-alpha.2`]
- Install type: [packaged installer / portable ZIP / `npm run dev` from source]
- llama.cpp binary: [path + `llama-server --version` output if relevant]
- Hardware: [CPU, GPU + VRAM, RAM — only if the bug is performance / OOM related]

**Additional context**
Anything else worth knowing — recent changes, what you were trying to achieve, models involved (size, quant, format), MCP client used, etc.
