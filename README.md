# Adaptive Memory for OpenClaw

## Problem

Currently, OpenClaw sessions load all memory data upfront via `SESSION INITIALIZATION RULE` in AGENTS.md:
- Loads SOUL.md, USER.md, IDENTITY.md unconditionally
- Loads daily memory if it exists
- For technical/process requests, this is often unnecessary overhead
- Personal/project-specific data clutters context when not needed

## Solution

A **hook + skill** that:
1. Starts sessions with **minimal context** (only SOUL, USER, IDENTITY)
2. After the first user prompt, triggers a **vector search** to find relevant memory chunks
3. Pulls only **relevant information** into context before responding
4. Maintains full memory access while optimizing initial load

## Benefits

- ✅ Faster session startup (no full memory load)
- ✅ Cleaner context for off-topic requests
- ✅ Still accesses deep context when needed
- ✅ Works transparently — user doesn't notice the difference

## Architecture

```
Session Start
    ↓
Load SOUL.md, USER.md, IDENTITY.md only
    ↓
User sends first message
    ↓
Hook: adaptive_memory.js triggers
    ↓
Skill: Analyzes prompt + vector searches memory
    ↓
Relevant chunks loaded into context
    ↓
Response generated with full context
    ↓
Subsequent messages (context already loaded)
```

## Files

- `SKILL.md` — Skill documentation
- `hook.js` — Triggers after first user prompt
- `search.js` — Vector search implementation
- `install.sh` — Setup script
- `test.js` — Test suite

## Installation

```bash
./install.sh
```

This configures the hook in your OpenClaw setup to activate on new sessions.

## Development Notes

- Hook triggers on `first_user_message` event
- Search uses existing OpenClaw embeddings
- Loads chunks into session context via MEMORY.md or memory/daily file
- Fallback: if search fails, session continues normally
