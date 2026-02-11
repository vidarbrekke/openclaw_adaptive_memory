# Adaptive Memory - Quick Start

Get Adaptive Memory running in 5 minutes.

## Installation (3 steps)

### 1. Add Hook to OpenClaw Config

Edit `~/.openclaw/openclaw.json` and add:

```json
{
  "hooks": {
    "onFirstMessage": {
      "name": "adaptive_memory",
      "path": "/Users/vidarbrekke/Dev/adaptive_memory/hook.js",
      "enabled": true
    }
  }
}
```

### 2. Restart OpenClaw

```bash
openclaw gateway restart
```

### 3. Test It

Create a new session and send your first message:
```
"What are my active projects?"
```

Look for the injected context in `memory/YYYY-MM-DD.md`:
```
## Adaptive Memory Context (auto-injected)
```

## Configuration

Fine-tune in `config.json`:

```json
{
  "enableAdaptiveMemory": true,      // true to enable globally
  "searchTopK": 3,                   // How many chunks to inject
  "minRelevanceScore": 0.5,          // Lower = more results (0.0-1.0)
  "debounceMs": 500,                 // Delay between searches
  "fallbackBehavior": "continue_without_context"  // Safe default
}
```

## Testing

```bash
# Run full test suite
npm run integration-test

# Test search manually
node search.js "your query here"

# Test hook with message
node hook.js "What are my projects?"
```

## How It Works

```
1. Session starts (minimal context)
   ↓
2. You send first message
   ↓
3. Adaptive Memory hook fires automatically
   ↓
4. Searches your memory files for relevant chunks
   ↓
5. Top 3 chunks injected to memory/YYYY-MM-DD.md
   ↓
6. You see the context in your next interaction
```

## Disable If Needed

**Disable globally:**
```json
{
  "enableAdaptiveMemory": false
}
```

**Remove hook completely:**
- Edit `~/.openclaw/openclaw.json`
- Delete the `onFirstMessage` hook entry
- Restart OpenClaw

## Debug Output

Enable verbose logging in `config.json`:
```json
{
  "enableLogging": true,
  "logLevel": "debug"
}
```

Then watch logs:
```bash
tail -f ~/.openclaw/logs/sessions.log | grep adaptive-memory
```

## What Gets Injected

Adaptive Memory looks for relevant chunks in:
- `~/clawd/memory/*.md` (all markdown files)
- `~/clawd/memory/**/*.md` (subdirectories)
- JSON files are also searched

It **skips** hidden directories (starting with `.`).

## Examples

### Query: "What are my projects?"
Finds chunks from:
- memory/projects.md
- memory/user/projects/*/
- memory/index.md (if mentions projects)

### Query: "Infrastructure setup"
Finds chunks from:
- memory/infrastructure.md
- memory/technical.md
- Any file mentioning infrastructure

### Query: "OpenClaw"
Finds chunks from:
- memory/*.md files mentioning OpenClaw
- Related configuration, tools, setup notes

## Performance

**Typical first-message latency:** 150-400ms
- Search: 100-300ms
- Injection: <10ms
- Rest: OpenClaw overhead

No noticeable delay for most users.

## Troubleshooting

### Hook not running?
- [ ] Hook is in `~/.openclaw/openclaw.json`?
- [ ] OpenClaw restarted after config change?
- [ ] `enableAdaptiveMemory: true` in `config.json`?

### Search finds nothing?
- [ ] Memory files exist in `~/clawd/memory/`?
- [ ] Try lowering `minRelevanceScore` to 0.3
- [ ] Test manually: `node search.js "your query"`

### Context not visible?
- [ ] Check `memory/2026-02-11.md` (or today's date)
- [ ] Look for "Adaptive Memory Context" section
- [ ] Is memory file loaded by session init?

## Next Steps

1. **Test it** — Send a few messages, check injected context
2. **Fine-tune** — Adjust `minRelevanceScore` and `searchTopK` in config
3. **Monitor** — Watch logs to see what's being found
4. **Iterate** — Feedback loop (is it finding the right stuff?)

## Learn More

- **IMPLEMENTATION.md** — Full technical docs
- **SKILL.md** — OpenClaw skill documentation
- **hook.js** — Source code, well-commented
- **search.js** — Search algorithm details

---

**Version:** 0.1.0 | **Status:** Production-ready POC | **Last Updated:** 2026-02-11
