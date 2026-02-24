---
name: adaptive-memory
description: Adaptive memory lifecycle hook for OpenClaw: compacts daily memory on new/reset, refreshes session digest on startup, and injects relevant memory after first user prompt.
---

# Adaptive Memory Skill

Runs as a global hook that does lifecycle maintenance plus on-demand retrieval:
- startup/new/reset: keep daily memory compact and refresh digest
- first user prompt: retrieve and inject top relevant chunks from memory

## How it works

1. Gateway startup → cache pre-warm + `memory/session-digest.md` refresh.
2. Session `new`/`reset` → compact stale adaptive-memory sections in today's file + refresh digest.
3. First user message → hook runs once, intent extracted, search over `memoryDir` (default `~/.openclaw/memory`).
4. Top K chunks (by relevance) written to `memoryDir/YYYY-MM-DD.md` under "## Adaptive Memory Context (auto-injected)".
5. Agent uses compact startup memory + targeted injected context.
6. First-message de-dupe is tracked with per-session marker files in `~/.openclaw/adaptive-memory-first-message-sessions/` (race-safe across parallel sessions).

## Installation

Run `./install.sh` from this folder; it copies the skill to `~/.openclaw/skills/adaptive-memory` (if needed) and patches `~/.openclaw/openclaw.json` automatically. Restart OpenClaw. For ClawHub install or publish, see **dist/adaptive-memory/INSTALL.md**.

## Configuration

**Memory location (portable across machines):** If your OpenClaw memory lives outside `~/.openclaw/memory` (e.g. in a project like `clawd` with `memory/` and `MEMORY.md` in the project root), set one of these **before** starting the gateway so the hook finds the right path:

- **`OPENCLAW_MEMORY_DIR`** — Exact directory for memory (e.g. `/path/to/clawd/memory`).
- **`OPENCLAW_PROJECT_DIR`** — Project root; memory is assumed at `OPENCLAW_PROJECT_DIR/memory` (e.g. `OPENCLAW_PROJECT_DIR=/path/to/clawd`).

If neither is set, `memoryDir` in `config.json` (or default `~/.openclaw/memory`) is used. The hook logs a one-time warning if `memoryDir` is missing or not a directory.

Edit `config.json` for other options:

| Option | Default | Description |
|--------|---------|-------------|
| `enableAdaptiveMemory` | `true` | Master switch |
| `memoryDir` | env or `~/.openclaw/memory` | Where daily memory and sources live (overridable by env above) |
| `searchTopK` | `3` | Chunks to inject |
| `maxResultsPerSearch` | `12` | Initial search pool before top-K slicing |
| `minRelevanceScore` | `0.55` | Score threshold (0–1) |
| `maxInjectedCharsTotal` | `4000` | Cap total injected chars |
| `maxSnippetCharsEach` | `800` | Cap per-snippet chars |
| `fallbackBehavior` | `continue_without_context` | On error: continue or `load_all_memory` |
| `enableLogging` | `true` | Enable adaptive-memory runtime logs |
| `logLevel` | `info` | Log threshold: `debug`, `info`, `warn`, `error` |
| `coreMemoryPath` | `null` | Optional explicit path to `MEMORY.md` for maintenance optimization |

## Troubleshooting

- **Hook not firing** — Ensure `adaptive-memory` is enabled in `~/.openclaw/openclaw.json` under `hooks.internal.entries` and installed under `hooks.internal.installs`; restart OpenClaw.
- **No results / wrong path** — If memory is in a project (e.g. `clawd/memory/`), set `OPENCLAW_PROJECT_DIR` to the project root or `OPENCLAW_MEMORY_DIR` to the memory directory, then restart the gateway. `memoryDir` must exist and contain `.md` files. Lower `minRelevanceScore` to 0.3 to test.
- **No injection** — Daily file must be writable; check for "Adaptive Memory Context" in `memoryDir/YYYY-MM-DD.md`.
- **Digest not updating** — Ensure hook is enabled and receives `gateway:startup`/`command:new|reset` events; check gateway logs for `[adaptive-memory] session digest refresh`.
- **Optimization prompt/consent flow** — If memory files are bloated, the hook writes a one-time maintenance notice and waits for explicit consent before lossless compaction. Full snapshots are archived under `memory/archive/`.
- **Declined optimization keeps reappearing** — Explicit decline now snoozes prompts for 24h. You can reset by editing `~/.openclaw/adaptive-memory-maintenance-state.json`.
- **Need to clear a processed-session marker** — Remove the corresponding file in `~/.openclaw/adaptive-memory-first-message-sessions/` (or use session `reset`/`new` flow).

## Repo and tests

Repo layout and dist: **README.md**. Run tests: `npm test`, `npm run maintenance-test`, and `npm run integration-test`.
