#!/bin/bash

###############################################################################
# Adaptive Memory Installation Script
# 
# Registers the adaptive_memory hook with OpenClaw
###############################################################################

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${HOME}/.openclaw/openclaw.json"

echo "📦 Installing Adaptive Memory for OpenClaw..."
echo ""

# Check if OpenClaw config exists
if [ ! -f "$CONFIG_FILE" ]; then
  echo "❌ Error: OpenClaw config not found at $CONFIG_FILE"
  echo "   Make sure OpenClaw is installed and initialized."
  exit 1
fi

# Backup original config
BACKUP_FILE="${CONFIG_FILE}.backup.$(date +%s)"
cp "$CONFIG_FILE" "$BACKUP_FILE"
echo "✓ Backed up original config to $BACKUP_FILE"

# Make hook executable
chmod +x "$SCRIPT_DIR/hook.js"
chmod +x "$SCRIPT_DIR/search.js"
echo "✓ Made hook and search scripts executable"

# Register hook in OpenClaw config
# This is a simplified version; in production you'd use a proper JSON tool
echo ""
echo "⚙️  Registering hook with OpenClaw..."
echo ""
echo "To complete installation, add this to your ~/.openclaw/openclaw.json:"
echo ""
cat << 'EOF'
{
  "hooks": {
    "onFirstMessage": {
      "name": "adaptive_memory",
      "path": "/Users/vidarbrekke/Dev/adaptive_memory/hook.js",
      "enabled": true
    }
  }
}
EOF

echo ""
echo "ℹ️  Note: Manual config update required until we add JSON patching."
echo ""

# Create installation marker
touch "$SCRIPT_DIR/.installed"
echo ""
echo "✅ Adaptive Memory installation complete!"
echo ""
echo "Next steps:"
echo "1. Edit ~/.openclaw/openclaw.json and add the hook configuration above"
echo "2. Restart OpenClaw: openclaw gateway restart"
echo "3. Create a new session to test adaptive memory loading"
echo ""
