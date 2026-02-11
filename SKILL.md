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
- **Writes to memory/YYYY-MM-DD.md** — Standard daily memory file
- **Uses clear section header** — "## Adaptive Memory Context (auto-injected)"
- **Includes metadata** — Source paths, relevance scores, timestamps
- **Transparent** — User can see what was loaded in session transcript
- **Natural integration** — Agent reads daily memory as normal, context appears organically

## Installation

Adaptive Memory is **enabled globally by default**. No installation needed for standard use.

To manually register or customize:
```bash
cd /path/to/adaptive_memory
./install.sh
```

This registers the hook in `~/.openclaw/openclaw.json` under `hooks.onFirstMessage`.

**Note:** Global enable means the hook runs on all new sessions automatically.

## Configuration

Edit `config.json` to customize behavior:

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

- `enableAdaptiveMemory` — Toggle feature on/off (default: true, global)
- `searchTopK` — Number of memory chunks to retrieve (default: 3)
- `minRelevanceScore` — Filter low-relevance results (default: 0.5, range 0-1)
- `debounceMs` — Delay before executing search (default: 500ms, prevents duplicate searches)
- `fallbackBehavior` — What to do if search fails (default: continue_without_context)
  - `continue_without_context` — Respond normally without injected context (safest)
  - `load_all_memory` — Fall back to loading full MEMORY.md (older behavior)

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

## How Adaptive Memory Differs from Standard Session Init

### Standard (AGENTS.md SESSION INITIALIZATION RULE)
- Loads SOUL.md, USER.md, IDENTITY.md, daily memory **unconditionally**
- All context loaded upfront, even if user only needs technical help
- High initial context size
- Slower session startup

### Adaptive Memory (This Skill)
- Loads SOUL.md, USER.md, IDENTITY.md only initially
- **After first user message**, analyzes intent via vector search
- **Only relevant chunks** appended to daily memory
- User gets precise context for their specific request
- Faster startup, cleaner context, better focus

## Future Enhancements

- [ ] Caching of search results to avoid redundant lookups
- [ ] User feedback loop (rate relevance of loaded chunks)
- [ ] Hybrid search (keyword + vector embedding)
- [ ] Per-project memory profiles with custom search weights
- [ ] Analytics dashboard (what memory gets loaded vs actually used)
- [ ] Smart injection timing (detect when user might need new context mid-session)
- [ ] Cross-session learning (popular context patterns)

## Related

- AGENTS.md — Session initialization rules
- MEMORY.md — Long-term memory storage
- memory/*.md — Daily session logs
