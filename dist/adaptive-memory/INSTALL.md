# Adaptive Memory — Installation

This folder is the **distribution bundle** for the Adaptive Memory skill. It contains everything needed to run the skill and to publish it to ClawHub (clawhub.ai).

## Install for end users

### Option A: Install from ClawHub (recommended)

If the skill is published on ClawHub:

```bash
# Install CLI once (if needed)
npm i -g clawhub

# Log in (one-time)
clawhub login

# Install the skill into your workspace
clawhub install adaptive-memory
```

Then register the hook (this skill uses an OpenClaw **hook**, not only the skill loader):

1. Locate the installed folder (e.g. `<workspace>/skills/adaptive-memory` or `~/.openclaw/skills/adaptive-memory`).
2. Run from that folder:
   ```bash
   ./install.sh
   ```
3. Copy the printed JSON into `~/.openclaw/openclaw.json` under `hooks.onFirstMessage` (use the path the script prints).
4. Restart OpenClaw: `openclaw gateway restart`.

### Option B: Manual install (copy this folder)

1. Copy this entire folder to your OpenClaw skills directory, for example:
   - `<workspace>/skills/adaptive-memory`, or
   - `~/.openclaw/skills/adaptive-memory`
2. From the copied folder, run:
   ```bash
   chmod +x hook.js search.js install.sh
   ./install.sh
   ```
3. Add the hook block printed by `install.sh` to `~/.openclaw/openclaw.json` (ensure the `path` points to the **actual** path of `hook.js`).
4. Restart OpenClaw.

### After install

- Memory files are read from `memoryDir` (default `~/.openclaw/memory`). Create that directory and add `.md` or `.json` memory files if needed.
- Injected context is written to `memoryDir/YYYY-MM-DD.md`. The hook runs on the first user message of each session.

---

## Publish to ClawHub (for maintainers)

To publish this skill to clawhub.ai so others can install it with `clawhub install adaptive-memory`:

### Prerequisites

- Node.js and `clawhub` CLI: `npm i -g clawhub`
- Logged in: `clawhub login` (GitHub account at least one week old)
- **Version bump:** Before each publish, update the `version` in `SKILL.md` frontmatter (semver). The CLI rejects uploads without a version bump.
- **Changelog:** Add a short entry to `CHANGELOG.md` for the new version.

### Publish from this folder

From the **skill folder** (this `adaptive-memory` directory):

```bash
clawhub publish . --slug adaptive-memory --name "Adaptive Memory" --tags latest
```

Or with explicit version and changelog:

```bash
clawhub publish . --slug adaptive-memory --name "Adaptive Memory" --version 0.2.0 --changelog "Per-session de-dupe, mtime cache, bounded injection" --tags latest
```

- `--slug` — Registry identifier (defaults to folder name).
- `--name` — Display name on ClawHub.
- `--version` — Semver (should match `SKILL.md` frontmatter).
- `--changelog` — Short description for this version.
- `--tags` — Comma-separated (e.g. `latest`).

After publishing, the skill appears in search and can be installed with:

```bash
clawhub install adaptive-memory
```

### Conventions for ClawHub

- **SKILL.md** must have YAML frontmatter with at least `name` and `description`. Include `version` and keep it in sync with each release.
- **CHANGELOG.md** is checked by the CLI; keep a short history of changes per version.
- Do not include dev-only files (e.g. test runners, internal design docs) in the published bundle; this `dist/adaptive-memory/` folder is the exact bundle to publish.
