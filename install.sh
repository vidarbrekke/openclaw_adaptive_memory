#!/bin/bash

###############################################################################
# Adaptive Memory Installation Script
# Copy this folder to ~/.openclaw/skills/adaptive-memory if needed, then
# register the hook in ~/.openclaw/openclaw.json. Run from anywhere.
###############################################################################

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${HOME}/.openclaw/skills/adaptive-memory"
CONFIG_FILE="${HOME}/.openclaw/openclaw.json"
HOOK_PATH="${SCRIPT_DIR}/hook.js"
ENTRY_ID="adaptive-memory"

# If we're not already in the skills folder, copy there and re-run
if [ "$SCRIPT_DIR" != "$TARGET_DIR" ]; then
  echo "📦 Installing Adaptive Memory for OpenClaw..."
  echo "  Copying to $TARGET_DIR"
  mkdir -p "$TARGET_DIR"
  cp -r "$SCRIPT_DIR"/* "$TARGET_DIR"/
  chmod +x "$TARGET_DIR/hook.js" "$TARGET_DIR/search.js" "$TARGET_DIR/install.sh"
  exec "$TARGET_DIR/install.sh"
fi

echo "📦 Installing Adaptive Memory for OpenClaw..."
echo ""

if [ ! -f "$CONFIG_FILE" ]; then
  echo "❌ Error: OpenClaw config not found at $CONFIG_FILE"
  echo "   Make sure OpenClaw is installed and initialized."
  exit 1
fi

# Backup
BACKUP_FILE="${CONFIG_FILE}.backup.$(date +%s)"
cp "$CONFIG_FILE" "$BACKUP_FILE"
echo "✓ Backed up config to $BACKUP_FILE"

chmod +x "$SCRIPT_DIR/hook.js" "$SCRIPT_DIR/search.js"
echo "✓ Made hook and search executable"

# Install as a native OpenClaw hook pack (schema-safe, managed install path).
if ! openclaw hooks install "$SCRIPT_DIR"; then
  # Reinstall path hook packs by replacing existing managed directory.
  rm -rf "${HOME}/.openclaw/hooks/${ENTRY_ID}"
  if ! openclaw hooks install "$SCRIPT_DIR"; then
    echo "❌ Failed to install hook pack from $SCRIPT_DIR"
    exit 1
  fi
fi

openclaw hooks enable "$ENTRY_ID" >/dev/null 2>&1 || true

# Remove legacy extraDirs link if present (avoids duplicate directory scans).
node -e '
const fs = require("fs");
const p = process.argv[1];
let cfg;
try { cfg = JSON.parse(fs.readFileSync(p, "utf8")); } catch { process.exit(0); }
const arr = cfg?.hooks?.internal?.load?.extraDirs;
if (Array.isArray(arr)) {
  cfg.hooks.internal.load.extraDirs = arr.filter(x => x !== process.argv[2]);
  if (cfg.hooks.internal.load.extraDirs.length === 0) {
    delete cfg.hooks.internal.load.extraDirs;
    if (Object.keys(cfg.hooks.internal.load).length === 0) delete cfg.hooks.internal.load;
  }
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
}
' "$CONFIG_FILE" "$SCRIPT_DIR"

echo "✓ Installed and enabled hook: $ENTRY_ID"

echo ""
echo "✅ Installation complete. Restart OpenClaw, then start a new session to test."
echo "   Restart: openclaw gateway restart"
echo ""
