# Adaptive Memory — Quick Start

1. **Install and register hook** — Run `./install.sh` from this folder (it patches `~/.openclaw/openclaw.json` automatically).
2. **Restart gateway process** — Use your normal OpenClaw startup method (`openclaw gateway restart` if service-managed, otherwise restart your manual gateway process).
3. **Verify lifecycle maintenance** — Start a new session and check `~/.openclaw/memory/session-digest.md` updates.
4. **Verify injection** — Send a message and confirm `~/.openclaw/memory/YYYY-MM-DD.md` contains "## Adaptive Memory Context (auto-injected)".
5. **Verify consent-gated optimization** — When memory files exceed thresholds, a maintenance note is appended to daily memory and optimization waits for explicit user approval.

**Config:** `config.json` (see **SKILL.md** for options). **Install from ClawHub / publish:** **dist/adaptive-memory/INSTALL.md**. **Overview:** **README.md**.
