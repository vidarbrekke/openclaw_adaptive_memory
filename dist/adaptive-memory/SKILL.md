---
name: adaptive-memory
version: 0.2.0
description: On-demand memory loading hook for OpenClaw that retrieves and injects only relevant memory after the first user prompt. Use when reducing startup context load, preventing irrelevant memory pollution, and keeping session context bounded and deterministic.
---

# Adaptive Memory Skill

## Description

Hook + skill that loads memory on-demand after the first user prompt rather than upfront.

Analyzes the user's intent via vector search and pulls only relevant memory chunks into context, reducing initial session load while preserving full memory access.

## Usage

This skill is installed as a **global automatic hook** in OpenClaw. It runs by default on all new sessions. No explicit invocation needed.

### How It Works

1. **Session starts** → Loads SOUL.md, USER.md, IDENTITY.md only (minimal bootstrap)
2. **User sends first message** → Hook fires automatically (global, no opt-out)
3. **Hook analyzes prompt** → Adaptive Memory vector search against full memory files
4. **Relevant chunks identified** → Top K chunks ranked by relevance score
5. **Context injected** → Chunks appended to memory/YYYY-MM-DD.md in "Adaptive Memory Context" section
6. **Response generated** → Agent naturally picks up injected context from daily memory
7. **Subsequent messages** → No re-search needed (context already in daily file)

### Context Injection Strategy (Best Practice)

Rather than directly modifying session state, Adaptive Memory:
- **Writes to memory/YYYY-MM-DD.md** — Standard daily memory file (under `memoryDir`, default `~/.openclaw/memory`)
- **Uses clear section header** — "## Adaptive Memory Context (auto-injected)"
- **Includes metadata** — Source paths, relevance scores, timestamps
- **Transparent** — User can see what was loaded in session transcript
- **Natural integration** — Agent reads daily memory as normal, context appears organically

## Installation

See **INSTALL.md** in this folder for step-by-step instructions (ClawHub install, manual install, and hook registration).

Quick steps:
1. Install the skill (e.g. `clawhub install adaptive-memory` or copy this folder into your workspace `skills/` or `~/.openclaw/skills/`).
2. Run `./install.sh` from this folder to register the hook, or add the hook entry to `~/.openclaw/openclaw.json` (path must point to `hook.js` in this folder).
3. Restart OpenClaw and start a new session.

## Configuration

Edit `config.json` in this folder to customize behavior:

```json
{
  "enableAdaptiveMemory": true,
  "searchTopK": 3,
  "maxResultsPerSearch": 12,
  "minRelevanceScore": 0.55,
  "maxInjectedCharsTotal": 4000,
  "maxSnippetCharsEach": 800,
  "debounceMs": 500,
  "fallbackBehavior": "continue_without_context",
  "memoryDir": "~/.openclaw/memory"
}
```

### Parameters

- `enableAdaptiveMemory` — Toggle feature on/off (default: true)
- `memoryDir` — Where daily memory files live (default: `~/.openclaw/memory`)
- `searchTopK` — Number of memory chunks to retrieve (default: 3)
- `maxResultsPerSearch` — Initial search pool before top-K slicing (default: 12)
- `minRelevanceScore` — Filter low-relevance results (default: 0.55, range 0-1)
- `maxInjectedCharsTotal` — Cap total injected characters (default: 4000)
- `maxSnippetCharsEach` — Cap per-snippet characters (default: 800)
- `debounceMs` — Delay before executing search (default: 500ms)
- `fallbackBehavior` — If search fails: `continue_without_context` (default) or `load_all_memory`

## Troubleshooting

- **Hook not firing** — Check hook is in `~/.openclaw/openclaw.json` under `hooks.onFirstMessage`; path must point to this folder’s `hook.js`. Restart OpenClaw.
- **Search returns nothing** — Ensure `memoryDir` exists and contains `.md` or `.json` memory files. Lower `minRelevanceScore` to 0.3 to test.
- **Context not injected** — Check daily memory file is writable; look for "Adaptive Memory Context" section in `memoryDir/YYYY-MM-DD.md`.

## How Adaptive Memory Differs from Standard Session Init

- **Standard:** Loads SOUL, USER, IDENTITY, and daily memory unconditionally; high initial context.
- **Adaptive Memory:** Loads only SOUL, USER, IDENTITY initially; after first message, injects only relevant chunks into daily memory. Faster startup, bounded context, same deep access when needed.
