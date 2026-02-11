# Adaptive Memory for OpenClaw

**Global on-demand memory loading for smarter, faster OpenClaw sessions.**

## Problem

Currently, OpenClaw sessions load all memory data upfront via `SESSION INITIALIZATION RULE` in AGENTS.md:
- Loads SOUL.md, USER.md, IDENTITY.md unconditionally
- Loads daily memory if it exists
- For technical/process requests, this is often unnecessary overhead
- Personal/project-specific data clutters context when not needed
- Slower session startup, noisy context, less focused responses

## Solution

**Adaptive Memory** — a **global hook + skill** that:
1. Starts sessions with **minimal context** (only SOUL, USER, IDENTITY)
2. After the first user prompt, triggers **Adaptive Memory vector search** to find relevant chunks
3. Pulls only **relevant information** into memory/YYYY-MM-DD.md naturally
4. Maintains full memory access while optimizing initial load and context focus

**Enabled by default globally.** No opt-in needed; works transparently.

## Benefits

- ✅ Faster session startup (no full memory load)
- ✅ Cleaner context for off-topic requests
- ✅ Still accesses deep context when needed
- ✅ Works transparently — user doesn't notice the difference

## Architecture

```
Session Start (Adaptive Memory enabled globally)
    ↓
Load SOUL.md, USER.md, IDENTITY.md only (minimal)
    ↓
User sends first message: "What are my active projects?"
    ↓
Hook: adaptive_memory.js fires (global, automatic)
    ↓
Intent extraction: "active projects"
    ↓
Adaptive Memory vector search against full memory files
    ↓
Top 3 results ranked by relevance score
    ↓
Chunks written to memory/YYYY-MM-DD.md 
    in "Adaptive Memory Context (auto-injected)" section
    ↓
Agent reads daily memory naturally, sees injected context
    ↓
Response generated with precise, focused context
    ↓
Subsequent messages use already-injected context
```

## Files

- `SKILL.md` — Skill documentation
- `hook.js` — Triggers after first user prompt
- `search.js` — Vector search implementation
- `install.sh` — Setup script
- `test.js` — Test suite

## Installation

**Adaptive Memory is enabled globally by default.** No installation needed for standard use.

To manually register or customize:
```bash
./install.sh
```

This configures the hook in your OpenClaw setup to activate on new sessions.

**To disable globally:** Set `enableAdaptiveMemory: false` in `config.json`.

## Development Notes

- Hook triggers on `first_user_message` event
- Search uses existing OpenClaw embeddings
- Loads chunks into session context via MEMORY.md or memory/daily file
- Fallback: if search fails, session continues normally
