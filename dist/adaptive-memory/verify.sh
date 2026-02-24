#!/usr/bin/env bash

# Adaptive Memory dist verification
# Verifies the published bundle contains runnable artifacts only.

set -euo pipefail

echo "Adaptive Memory - Dist Verification"
echo "==================================="
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "✗ Node.js is required"
  exit 1
fi
echo "✓ Node.js: $(node --version)"

echo ""
echo "📁 Checking dist files:"
for file in \
  hook.js search.js utils.js handler.js config.json install.sh package.json \
  SKILL.md INSTALL.md CHANGELOG.md README.md QUICKSTART.md HOOK.md LICENSE \
  hooks/adaptive-memory/handler.js hooks/adaptive-memory/HOOK.md; do
  if [ -f "$file" ]; then
    echo "  ✓ $file"
  else
    echo "  ✗ $file (missing)"
    exit 1
  fi
done

echo ""
echo "📦 Checking JS module loadability:"
node -e "require('./hook.js'); console.log('  ✓ hook.js loads')"
node -e "require('./search.js'); console.log('  ✓ search.js loads')"
node -e "require('./utils.js'); console.log('  ✓ utils.js loads')"
node -e "require('./handler.js'); console.log('  ✓ handler.js loads')"
node -e "require('./hooks/adaptive-memory/handler.js'); console.log('  ✓ hooks/adaptive-memory/handler.js loads')"

echo ""
echo "🧩 Checking config JSON:"
node -e "const fs=require('fs'); const c=JSON.parse(fs.readFileSync('./config.json','utf8')); console.log('  ✓ config.json valid'); console.log('    - enableAdaptiveMemory:', c.enableAdaptiveMemory); console.log('    - searchTopK:', c.searchTopK); console.log('    - minRelevanceScore:', c.minRelevanceScore)"

echo ""
echo "ℹ️ Notes:"
echo "  - This dist verifier does not require git."
echo "  - It does not run repo test scripts (not shipped in dist)."
echo "  - Runtime fail-open behavior depends on fallbackBehavior in config.json."

echo ""
echo "✅ Dist verification passed."
