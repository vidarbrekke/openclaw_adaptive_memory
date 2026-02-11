#!/usr/bin/env bash
# Sync runtime and config from repo root into dist/adaptive-memory.
# Does not overwrite dist-specific files: SKILL.md, INSTALL.md, CHANGELOG.md, package.json.

set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/dist/adaptive-memory"

if [ ! -d "$DIST" ]; then
  echo "Error: $DIST not found. Create dist/adaptive-memory first."
  exit 1
fi

cp "$ROOT/hook.js" "$ROOT/search.js" "$ROOT/config.json" "$ROOT/install.sh" "$ROOT/LICENSE" "$DIST/"
echo "Synced hook.js, search.js, config.json, install.sh, LICENSE to dist/adaptive-memory/"
echo "SKILL.md, INSTALL.md, CHANGELOG.md, package.json in dist are left unchanged (edit there if needed)."
