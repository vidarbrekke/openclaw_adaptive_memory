# Adaptive Memory: Implementation Guide

**Version:** 0.2.0

---

## Overview

Adaptive Memory is an OpenClaw hook + skill that:
1. Starts sessions with minimal context (SOUL, USER, IDENTITY only)
2. After first user message, triggers vector search
3. Injects relevant memory chunks into daily memory file
4. Agent naturally picks up injected context

**Global by default** — no opt-in required, works transparently.

---

## Architecture

### Components

```
┌─ hook.js ─────────────┐
│ - Listens for 1st msg │
│ - Extracts intent     │
│ - Calls search        │
│ - Injects to memory   │
└───────────────────────┘
          ↓
┌─ search.js ───────────┐
│ - Vector search       │
│ - Keyword fallback    │
│ - Scoring & ranking   │
│ - Returns top K       │
└───────────────────────┘
          ↓
┌─ memory/YYYY-MM-DD.md┐
│ - Receives chunks     │
│ - Section header      │
│ - Metadata included   │
└───────────────────────┘
```

### Data Flow

```
Session starts
    ↓
Load SOUL.md, USER.md, IDENTITY.md (minimal)
    ↓
User sends: "What are my projects?"
    ↓
hook.js fires → extractIntent()
    ↓
search.js → searchMemory("What are my projects?")
    ↓
Returns top 3 chunks ranked by score
    ↓
Chunks written to memory/YYYY-MM-DD.md
    ↓
Agent reads daily memory next
    ↓
Injected context available for response
```

---

## File Reference

### `hook.js`
**Purpose:** First-message hook: intent → search → inject.

**Key flow:** `onFirstMessage` → debounce → `extractIntent` (strip code blocks, normalize) → `shouldSearchMemory` (skip tech-only prompts) → `searchMemory` → `injectMemoryChunks`. Injection: per-session de-dupe via HTML comment marker, bounded by `maxInjectedCharsTotal` / `maxSnippetCharsEach`, atomic write (temp + rename). Config: **config.json** (see SKILL.md).

### `search.js`
**Purpose:** Keyword search over memory files with mtime cache.

**Key behaviour:** `searchMemory(query, options)` → `getMemoryFiles(memoryDir)` → `vectorSearchFiles` (or keyword fallback). Cache at `~/.openclaw/adaptive-memory-cache.json` keyed by file path + mtime; only changed files re-chunked. Chunking: split on markdown headings then paragraphs, cap 1200 chars/chunk, 200 chunks/file. Scoring: extracted keywords (stop words filtered), regex-escaped word-boundary matches, coverage + repeat bonus, 0–1 normalized. Snippets keep original casing.

**Performance:** ~100–300ms typical; cold cache first run, then faster.

### `config.json`
See repo root `config.json` and **SKILL.md** for options. Main: `memoryDir`, `searchTopK`, `minRelevanceScore`, `maxInjectedCharsTotal`, `maxSnippetCharsEach`, `debounceMs`, `fallbackBehavior`.

---

## Installation

Run `./install.sh`, add printed hook to `~/.openclaw/openclaw.json`, restart OpenClaw. ClawHub install/publish: **dist/adaptive-memory/INSTALL.md**. Disable: `enableAdaptiveMemory: false` in `config.json`.

---

## Testing

### Run Full Integration Test

```bash
npm run integration-test
# or
node integration-test.js
```

**Tests included:**
- Search finds relevant chunks
- Results ranked by relevance
- Respects maxResults parameter
- Filters by minScore
- Handles invalid queries
- Hook interface validation
- Message processing
- Config handling
- Full flow integration

### Manual CLI Testing

```bash
# Test hook with specific message
node hook.js "What are my active projects?"

# Test search with query
node search.js "projects and github"

# Run unit tests
npm test
```

### Debug Mode

Enable debug logging in `config.json`:
```json
{
  "enableLogging": true,
  "logLevel": "debug"
}
```

Then monitor session logs:
```bash
tail -f ~/.openclaw/logs/sessions.log | grep adaptive-memory
```

---

## Troubleshooting

### Hook Not Firing

**Symptom:** Context never injected into daily memory

**Check:**
1. Is hook registered in `~/.openclaw/openclaw.json`?
   ```bash
   cat ~/.openclaw/openclaw.json | grep adaptive_memory
   ```
2. Did you restart OpenClaw after adding hook?
   ```bash
   openclaw gateway restart
   ```
3. Is `enableAdaptiveMemory` true in `config.json`?
4. Check logs: `openclaw logs | grep adaptive-memory`

**Fix:**
- Verify hook path is correct (absolute path)
- Ensure hook.js is executable: `chmod +x hook.js`
- Restart OpenClaw and create new session

### Search Returns No Results

**Symptom:** Relevant memory exists but search finds nothing

**Check:**
1. Are memory files readable?
   ```bash
   ls -la ~/.openclaw/memory/
   ```
2. Is memoryDir path correct in config.json?
3. Are keywords at least 3 chars?
4. Try manual search:
   ```bash
   node search.js "your query here"
   ```

**Fix:**
- Lower `minRelevanceScore` in config.json (try 0.3)
- Check file format (should be .md or .json)
- Verify memory files have content related to query

### Context Not Appearing in Session

**Symptom:** Chunks injected to memory but agent doesn't see them

**Check:**
1. Is memory file being updated?
   ```bash
   tail -50 ~/.openclaw/memory/2026-02-11.md
   ```
2. Look for "Adaptive Memory Context" section
3. Is daily memory being loaded by agent?
   - Check AGENTS.md SESSION INITIALIZATION RULE
   - Verify daily memory is in agent's context window

**Fix:**
- Check daily memory file has valid Markdown syntax
- Ensure SOUL.md/USER.md load daily memory by default
- Verify injection happened before agent's context load

### High Latency on First Message

**Symptom:** First message takes >1 second to respond

**Check:**
1. How many memory files? (Large corpus = slower search)
   ```bash
   find ~/.openclaw/memory -name "*.md" | wc -l
   ```
2. Is search taking too long?
   ```bash
   time node search.js "test query"
   ```

**Fix:**
- Archive old memory (move to separate directory)
- Reduce `maxResultsPerSearch` in config.json
- Increase `minRelevanceScore` to filter earlier
- Consider implementing real vector embeddings (future phase)

### Config Not Being Picked Up

**Symptom:** Changes to config.json don't take effect

**Check:**
1. Is config.json in project root?
   ```bash
   ls -la ./config.json
   ```
2. Is JSON syntax valid?
   ```bash
   node -e "console.log(JSON.parse(require('fs').readFileSync('./config.json')))"
   ```

**Fix:**
- Fix JSON syntax errors
- Restart OpenClaw gateway
- Create new session (config loaded per-session)

---

## Performance Metrics

Measured on MacBook Pro with ~30 memory files:

| Operation | Time | Notes |
|-----------|------|-------|
| Intent extraction | <5ms | Fast |
| Search initialization | ~50ms | File listing |
| Search scoring | 50-150ms | Depends on file size |
| **Total search** | **100-300ms** | Typical case |
| Injection to memory | <10ms | File write |
| **Full hook execution** | **150-400ms** | End-to-end |

With 100+ files: add ~200-400ms

---

## Development

Repo layout: **README.md**. Tests: `npm test`, `npm run integration-test`. Dist bundle: `dist/adaptive-memory/`, sync with `./scripts/sync-dist.sh`.

