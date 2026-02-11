# Changelog

All notable changes to the Adaptive Memory skill are documented here. Version numbers follow [semver](https://semver.org/).

## 0.2.0

- Per-session injection de-dupe (session-specific marker; no longer blocks multiple sessions per day).
- Bounded injection: `maxInjectedCharsTotal` and `maxSnippetCharsEach` to prevent context explosion.
- Atomic file writes (temp file + rename) for memory and cache.
- mtime-based persistent cache (`~/.openclaw/adaptive-memory-cache.json`); only changed files re-chunked.
- Markdown-aware chunking (split on headings, then paragraphs; caps per file).
- Regex-safe keyword scoring (escape special characters; preserve original snippet casing).
- Intent extraction: strip fenced code blocks and normalize whitespace.
- Tech-prompt heuristic: skip memory search for purely technical prompts when no personal/project cues.
- Default memory path: `~/.openclaw/memory` (overridable via `memoryDir` or `OPENCLAW_MEMORY_DIR`).
- Distribution bundle in `dist/adaptive-memory/` with INSTALL.md and ClawHub publish instructions.

## 0.1.0

- Initial release: on-first-message hook, keyword-based search, injection into daily memory file.
- Configurable via `config.json` (searchTopK, minRelevanceScore, debounceMs, fallbackBehavior).
