---
name: adaptive-memory
version: 0.3.0
description: Adaptive memory lifecycle hook for OpenClaw: compacts daily memory on new/reset, refreshes session digest on startup, and injects relevant memory after first user prompt.
---

# Adaptive Memory Skill

## Description

Hook + skill that keeps startup memory lean and loads targeted memory on-demand.

Analyzes the user's intent via cached keyword scoring and pulls only relevant memory chunks into context, reducing initial session load while preserving full memory access.

## Usage

This skill is installed as a **global automatic hook** in OpenClaw. It runs by default on all new sessions. No explicit invocation needed.

### How It Works

1. **Gateway startup** → Hook pre-warms search cache and refreshes `memory/session-digest.md`
2. **Session new/reset** → Hook compacts stale adaptive-memory sections in today's daily file
3. **Bloat detection** → If core memory files are too large, hook writes a one-time maintenance notice and waits for explicit user consent
4. **User sends first message** → Hook fires once per session
5. **Hook analyzes prompt** → Adaptive Memory cached keyword search against memory files
6. **Relevant chunks identified** → Top K chunks ranked by relevance score
7. **Context injected** → Chunks appended to memory/YYYY-MM-DD.md in "Adaptive Memory Context" section
8. **Subsequent messages** → No re-search needed (context already in daily file)
9. **Race-safe de-dupe** → First-message processing is tracked by per-session marker files in `~/.openclaw/adaptive-memory-first-message-sessions/`

### Context Injection Strategy (Best Practice)

Rather than directly modifying session state, Adaptive Memory:
- **Writes to memory/YYYY-MM-DD.md** — Standard daily memory file (under `memoryDir`; see env vars below for project-based installs)
- **Uses clear section header** — "## Adaptive Memory Context (auto-injected)"
- **Includes metadata** — Source paths, relevance scores, timestamps
- **Transparent** — User can see what was loaded in session transcript
- **Natural integration** — Agent reads daily memory as normal, context appears organically

## Installation

See **INSTALL.md** in this folder for step-by-step instructions (ClawHub install, manual install, and hook registration).

Quick steps:
1. Install the skill (e.g. `clawhub install adaptive-memory` or copy this folder into your workspace `skills/` or `~/.openclaw/skills/`).
2. Run `./install.sh` from this folder (it patches `~/.openclaw/openclaw.json` automatically).
3. Restart OpenClaw and start a new session.

## Configuration

**Memory location (portable):** If your OpenClaw memory is outside `~/.openclaw/memory` (e.g. project `clawd` with `memory/` and `MEMORY.md` in project root), set **before** starting the gateway:
- **`OPENCLAW_MEMORY_DIR`** — Exact memory directory (e.g. `/path/to/clawd/memory`).
- **`OPENCLAW_PROJECT_DIR`** — Project root; memory is assumed at `OPENCLAW_PROJECT_DIR/memory`.

If unset, `memoryDir` in `config.json` (default `~/.openclaw/memory`) is used. The hook logs a one-time warning if the directory is missing.

Edit `config.json` in this folder to customize behavior:

```json
{
  "enableAdaptiveMemory": true,
  "searchTopK": 3,
  "maxResultsPerSearch": 12,
  "minRelevanceScore": 0.55,
  "maxInjectedCharsTotal": 4000,
  "maxSnippetCharsEach": 800,
  "fallbackBehavior": "continue_without_context",
  "memoryDir": "~/.openclaw/memory"
}
```

### Parameters

- `enableAdaptiveMemory` — Toggle feature on/off (default: true)
- `memoryDir` — Where daily memory files live (default: env or `~/.openclaw/memory`; overridable by env above)
- `searchTopK` — Number of memory chunks to retrieve (default: 3)
- `maxResultsPerSearch` — Initial search pool before top-K slicing (default: 12)
- `minRelevanceScore` — Filter low-relevance results (default: 0.55, range 0-1)
- `maxInjectedCharsTotal` — Cap total injected characters (default: 4000)
- `maxSnippetCharsEach` — Cap per-snippet characters (default: 800)
- `fallbackBehavior` — If search fails: `continue_without_context` (default) or `load_all_memory`
- `enableLogging` — Enable runtime logs (default: true)
- `logLevel` — Log threshold: `debug`, `info`, `warn`, `error` (default: `info`)
- `coreMemoryPath` — Optional explicit path to `MEMORY.md` for maintenance optimization

## Troubleshooting

- **Hook not firing** — Ensure `adaptive-memory` is enabled in `~/.openclaw/openclaw.json` under `hooks.internal.entries` and the hook is installed under `hooks.internal.installs`. Restart OpenClaw.
- **Search returns nothing / wrong path** — If memory is in a project (e.g. `clawd/memory/`), set `OPENCLAW_PROJECT_DIR` to project root or `OPENCLAW_MEMORY_DIR` to the memory directory, then restart the gateway. Ensure `memoryDir` exists and contains `.md` files. Lower `minRelevanceScore` to 0.3 to test.
- **Context not injected** — Check daily memory file is writable; look for "Adaptive Memory Context" section in `memoryDir/YYYY-MM-DD.md`.
- **Maintenance optimization not running** — Optimization is consent-gated by design. Confirm you gave explicit approval and check `memory/archive/` for full-snapshot backups.
- **Repeated maintenance prompts** — Explicit decline snoozes prompting for 24h; state is tracked in `~/.openclaw/adaptive-memory-maintenance-state.json`.
- **Need to clear processed-session state** — Remove the relevant file in `~/.openclaw/adaptive-memory-first-message-sessions/` (or use session `new`/`reset`).

## How Adaptive Memory Differs from Standard Session Init

- **Standard:** Loads SOUL, USER, IDENTITY, and daily memory unconditionally; high initial context.
- **Adaptive Memory:** Loads only SOUL, USER, IDENTITY initially; after first message, injects only relevant chunks into daily memory. Faster startup, bounded context, same deep access when needed.
