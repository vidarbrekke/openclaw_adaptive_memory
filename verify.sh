#!/bin/bash

# Adaptive Memory - Verification Script
# Checks that all components are in place and working

set -e

echo "🔍 Adaptive Memory - Verification"
echo "=================================="
echo ""

# Check Node.js
echo -n "✓ Node.js version: "
node --version

# Check project structure
echo ""
echo "📁 Project structure:"
for file in hook.js search.js config.json SKILL.md README.md IMPLEMENTATION.md QUICKSTART.md package.json .gitignore; do
  if [ -f "$file" ]; then
    echo "  ✓ $file"
  else
    echo "  ✗ $file (MISSING)"
    exit 1
  fi
done

# Check git
echo ""
echo "🔗 Git repository:"
if [ -d ".git" ]; then
  echo "  ✓ Git initialized"
  echo "  ✓ Commits:"
  git log --oneline | head -3 | sed 's/^/    /'
else
  echo "  ✗ Not a git repository"
  exit 1
fi

# Check Node module syntax
echo ""
echo "📦 Module validation:"
node -e "
  try {
    require('./hook.js');
    console.log('  ✓ hook.js is valid')
  } catch(e) {
    console.error('  ✗ hook.js error:', e.message);
    process.exit(1);
  }
"

node -e "
  try {
    require('./search.js');
    console.log('  ✓ search.js is valid')
  } catch(e) {
    console.error('  ✗ search.js error:', e.message);
    process.exit(1);
  }
"

node -e "
  try {
    const config = JSON.parse(require('fs').readFileSync('./config.json', 'utf8'));
    console.log('  ✓ config.json is valid')
    console.log('    - enableAdaptiveMemory:', config.enableAdaptiveMemory)
    console.log('    - searchTopK:', config.searchTopK)
    console.log('    - minRelevanceScore:', config.minRelevanceScore)
  } catch(e) {
    console.error('  ✗ config.json error:', e.message);
    process.exit(1);
  }
"

# Check documentation
echo ""
echo "📚 Documentation:"
for file in SKILL.md README.md IMPLEMENTATION.md QUICKSTART.md; do
  lines=$(wc -l < "$file")
  echo "  ✓ $file ($lines lines)"
done

# Summary
echo ""
echo "✅ All checks passed!"
echo ""
echo "Next steps:"
echo "  1. npm run maintenance-test    # Verify consent-gated maintenance flow"
echo "  2. npm run integration-test    # Run test suite"
echo "  3. ./install.sh                # Install hook"
echo "  4. Restart your gateway process"
echo "  5. Create new session and test # Verify it works"
echo ""

# Optional: execute key test commands when script is run directly
echo "🧪 Running maintenance flow test..."
npm run maintenance-test
echo "🧪 Running integration test..."
npm run integration-test
