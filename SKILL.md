---
name: adaptive-memory
description: On-demand memory loading hook for OpenClaw that retrieves and injects only relevant memory after the first user prompt. Use when reducing startup context load, preventing irrelevant memory pollution, and keeping session context bounded and deterministic.
---

# Adaptive Memory Skill

Loads memory on-demand after the first user prompt (keyword search over `memoryDir`, top K chunks injected into daily memory). Runs as a global hook; no explicit invocation.

## How it works

1. Session starts → SOUL, USER, IDENTITY only.
2. First user message → hook runs, intent extracted, search over `memoryDir` (default `~/.openclaw/memory`).
3. Top K chunks (by relevance) written to `memoryDir/YYYY-MM-DD.md` under "## Adaptive Memory Context (auto-injected)".
4. Agent reads daily memory; subsequent messages use already-injected context.

## Installation

Run `./install.sh` from this folder and add the printed JSON to `~/.openclaw/openclaw.json` under `hooks.onFirstMessage` (path must point to this folder’s `hook.js`). Restart OpenClaw. For ClawHub install or publish, see **dist/adaptive-memory/INSTALL.md**.

## Configuration

Edit `config.json`:

| Option | Default | Description |
|--------|---------|-------------|
| `enableAdaptiveMemory` | `true` | Master switch |
| `memoryDir` | `~/.openclaw/memory` | Where daily memory and sources live |
| `searchTopK` | `3` | Chunks to inject |
| `maxResultsPerSearch` | `12` | Initial search pool before top-K slicing |
| `minRelevanceScore` | `0.55` | Score threshold (0–1) |
| `maxInjectedCharsTotal` | `4000` | Cap total injected chars |
| `maxSnippetCharsEach` | `800` | Cap per-snippet chars |
| `debounceMs` | `500` | Debounce first-message search |
| `fallbackBehavior` | `continue_without_context` | On error: continue or `load_all_memory` |

## Troubleshooting

- **Hook not firing** — Hook entry in `~/.openclaw/openclaw.json` with correct `path` to `hook.js`; restart OpenClaw.
- **No results** — `memoryDir` must exist and contain `.md`/`.json`. Lower `minRelevanceScore` to 0.3 to test.
- **No injection** — Daily file must be writable; check for "Adaptive Memory Context" in `memoryDir/YYYY-MM-DD.md`.

## Repo and tests

Repo layout and dist: **README.md**. Run tests: `npm test` and `npm run integration-test`.
