# Adaptive Memory for OpenClaw

Global on-demand memory loading: minimal context at session start, then injects only relevant memory chunks after the first user message.

## What it does

- **Session start:** Loads SOUL.md, USER.md, IDENTITY.md only (no full memory).
- **First user message:** Hook runs → intent extraction → keyword search over `memoryDir` → top K chunks injected into `memoryDir/YYYY-MM-DD.md`.
- **Result:** Bounded, relevant context; full memory still available when needed.

## Files

| File        | Role |
|------------|------|
| `SKILL.md` | Skill description and config reference |
| `hook.js`  | First-message hook; calls search, injects chunks |
| `search.js`| Keyword search, mtime cache, markdown chunking |
| `config.json` | Options (memoryDir, searchTopK, caps, etc.) |
| `install.sh`  | Prints hook config for `~/.openclaw/openclaw.json` |

**Install:** Run `./install.sh`, add the printed hook block to `~/.openclaw/openclaw.json`, restart OpenClaw. Disable with `enableAdaptiveMemory: false` in `config.json`.

**Distribution:** The publishable bundle is `dist/adaptive-memory/`. See that folder’s **INSTALL.md** for end-user install and ClawHub publish. Refresh runtime files with `./scripts/sync-dist.sh` after code changes.

## Dist layout and publish

```bash
./scripts/sync-dist.sh   # copy hook.js, search.js, config.json, install.sh, LICENSE into dist
cd dist/adaptive-memory
# Bump version in SKILL.md and CHANGELOG.md, then:
clawhub publish . --slug adaptive-memory --name "Adaptive Memory" --tags latest
```

## Development

Tests: `npm test` and `npm run integration-test`. Hook uses `onFirstMessage`; search uses keyword scoring + `~/.openclaw/adaptive-memory-cache.json`; fallback on error is `continue_without_context`.
