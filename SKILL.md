# Adaptive Memory Skill

## Description

Hook + skill that loads memory on-demand after the first user prompt rather than upfront.

Analyzes the user's intent via vector search and pulls only relevant memory chunks into context, reducing initial session load while preserving full memory access.

## Usage

This skill is installed as an **automatic hook** in OpenClaw. No explicit invocation needed.

### How It Works

1. **Session starts** → Loads SOUL.md, USER.md, IDENTITY.md only (minimal bootstrap)
2. **User sends first message** → Hook fires automatically
3. **Hook analyzes prompt** → Vector search against full memory
4. **Relevant chunks loaded** → Injected into session context
5. **Response generated** → With full context available
6. **Subsequent messages** → No re-search needed (context already present)

## Installation

```bash
cd /path/to/adaptive_memory
./install.sh
```

This registers the hook in `~/.openclaw/openclaw.json` under `hooks.onFirstMessage`.

## Configuration

Edit `config.json` to customize:

```json
{
  "enableAdaptiveMemory": true,
  "searchTopK": 3,
  "minRelevanceScore": 0.5,
  "debounceMs": 500,
  "fallbackBehavior": "continue_without_context"
}
```

### Parameters

- `enableAdaptiveMemory` — Toggle feature on/off
- `searchTopK` — Number of memory chunks to retrieve
- `minRelevanceScore` — Filter low-relevance results
- `debounceMs` — Delay before executing search (avoids multiple fires)
- `fallbackBehavior` — What to do if search fails
  - `continue_without_context` — Respond normally (safest)
  - `load_all_memory` — Fall back to old behavior

## Development

### Project Structure

```
adaptive_memory/
├── SKILL.md                    # This file
├── README.md                   # Project overview
├── hook.js                     # Hook implementation
├── search.js                   # Vector search logic
├── config.json                 # Configuration
├── install.sh                  # Setup script
├── test.js                     # Test suite
└── .git/                       # Git repository
```

### Key Files

#### hook.js
Triggers after first user message. Detects if this is a new session, runs search, and injects results.

#### search.js
- Uses OpenClaw's `memory_search` tool
- Extracts intent from user prompt
- Ranks results by relevance
- Returns top K chunks

### Running Tests

```bash
npm test
```

## Troubleshooting

### Hook not firing
- Check that hook is registered: `cat ~/.openclaw/openclaw.json | grep adaptive_memory`
- Check OpenClaw logs: `openclaw logs`
- Verify hook.js is executable: `chmod +x hook.js`

### Search returning no results
- Verify MEMORY.md exists with content
- Check minRelevanceScore is not too high
- Run manual test: `node search.js "sample user message"`

### Context not being injected
- Check fallback behavior in config.json
- Verify memory file is writable
- Check session logs for errors

## Future Enhancements

- [ ] Caching of search results to avoid redundant lookups
- [ ] User feedback loop (rate relevance of loaded chunks)
- [ ] Hybrid search (keyword + vector)
- [ ] Per-project memory profiles
- [ ] Analytics on what memory gets loaded vs used

## Related

- AGENTS.md — Session initialization rules
- MEMORY.md — Long-term memory storage
- memory/*.md — Daily session logs
