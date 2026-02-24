# Adaptive Memory for OpenClaw

Adaptive memory maintenance + on-demand memory loading for OpenClaw. It keeps daily memory lean at lifecycle boundaries, pre-warms search cache, and injects only relevant memory chunks after the first user message.

## What it does

- **Gateway startup:** Hook pre-warms cache and refreshes `memory/session-digest.md`.
- **Session new/reset:** Hook compacts stale adaptive-memory blocks in today's daily file and refreshes session digest.
- **Consent-gated maintenance:** If core memory files are bloated, hook writes a one-time prompt and only optimizes after explicit user approval (with full archival backups).
- **First user message:** Hook runs once per session → intent extraction → keyword search over `memoryDir` → top K chunks injected into `memoryDir/YYYY-MM-DD.md`.
- **Session de-dupe safety:** First-message processing uses per-session marker files under `~/.openclaw/adaptive-memory-first-message-sessions/` to avoid cross-session race conditions.
- **Result:** Leaner startup daily memory + bounded relevant retrieval when user intent is known.

## Files

| File        | Role |
|------------|------|
| `SKILL.md` | Skill description and config reference |
| `hook.js`  | Lifecycle maintenance + first-message injection logic |
| `search.js`| Keyword search, mtime cache, markdown chunking |
| `config.json` | Options (memoryDir, searchTopK, caps, etc.) |
| `install.sh`  | One-command install: copies skill + patches `~/.openclaw/openclaw.json` |

**Install:** Run `./install.sh`, then restart OpenClaw. Disable with `enableAdaptiveMemory: false` in `config.json`.

**Distribution:** This folder is the publishable bundle. See **INSTALL.md** for end-user install and ClawHub publish.

## Publish

```bash
cd /path/to/adaptive-memory-dist/adaptive-memory
# Bump version in SKILL.md and CHANGELOG.md, then:
clawhub publish . --slug adaptive-memory --name "Adaptive Memory" --tags latest
```

## Development

Tests: `npm test`, `npm run maintenance-test`, and `npm run integration-test`. Hook runs on `gateway:startup` + `command` events; search uses cached keyword scoring with per-query matcher precompile + `~/.openclaw/adaptive-memory-cache.json`; fallback on error is `continue_without_context`.
