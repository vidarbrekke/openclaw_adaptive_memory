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

Then register the hook (this skill uses an OpenClaw **hook**). From the installed folder run `./install.sh` — it updates `~/.openclaw/openclaw.json` automatically — then restart OpenClaw: `openclaw gateway restart`.

### Option B: Manual install (copy of this folder)

One command: run the installer from this folder. It copies the bundle to `~/.openclaw/skills/adaptive-memory` and registers the hook.

```bash
./install.sh
```

(If needed: `chmod +x install.sh` then run it.) Then restart OpenClaw: `openclaw gateway restart`.

So with a copy of the dist directory, the full flow is: `./install.sh` → restart OpenClaw.

### After install

- Memory files are read from `memoryDir`. Default is `~/.openclaw/memory` unless you use a project layout (e.g. `clawd` with `memory/` in the project). Then set **before starting the gateway**: `OPENCLAW_PROJECT_DIR=/path/to/project` (memory at `project/memory/`) or `OPENCLAW_MEMORY_DIR=/path/to/memory`. Create the directory and add `.md` memory files if needed.
- Hook lifecycle maintenance also runs on gateway startup and session new/reset:
  - startup: pre-warm cache + refresh `session-digest.md`
  - new/reset: compact stale adaptive-memory sections in today's file
- Injected context is written to `memoryDir/YYYY-MM-DD.md`. Retrieval runs on first user message per session.
- First-message dedupe is tracked with per-session marker files in `~/.openclaw/adaptive-memory-first-message-sessions/` for parallel-session safety.
- If core memory files are detected as bloated, a one-time consent prompt is added; optimization only runs after explicit user approval and archives full snapshots before compaction.

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

Before publishing, run verification:

```bash
./verify.sh
```

Or with explicit version and changelog:

```bash
clawhub publish . --slug adaptive-memory --name "Adaptive Memory" --version 0.3.0 --changelog "Lifecycle maintenance, startup digest, consent-gated lossless optimization" --tags latest
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
