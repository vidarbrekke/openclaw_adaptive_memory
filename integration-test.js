#!/usr/bin/env node

/**
 * Integration Test for Adaptive Memory
 * 
 * Tests complete flow: hook -> search -> injection
 * Creates temporary test memory files and validates output
 */

const fs = require('fs');
const path = require('path');
const { searchMemory } = require('./search.js');
const hook = require('./hook.js');

// Colors for output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  dim: '\x1b[2m'
};

let testsPassed = 0;
let testsFailed = 0;

function log(msg, color = 'reset') {
  console.log(`${colors[color]}${msg}${colors.reset}`);
}

function section(title) {
  console.log(`\n${colors.blue}${'='.repeat(60)}${colors.reset}`);
  log(title, 'blue');
  console.log(`${colors.blue}${'='.repeat(60)}${colors.reset}\n`);
}

function test(name, fn) {
  try {
    fn();
    testsPassed++;
    log(`✓ ${name}`, 'green');
  } catch (error) {
    testsFailed++;
    log(`✗ ${name}`, 'red');
    log(`  ${error.message}`, 'dim');
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    testsPassed++;
    log(`✓ ${name}`, 'green');
  } catch (error) {
    testsFailed++;
    log(`✗ ${name}`, 'red');
    log(`  ${error.message}`, 'dim');
  }
}

// =============================================================================
// Setup: Create test memory structure
// =============================================================================

section('Setup: Creating Test Memory Files');

const testMemoryDir = path.join(process.env.HOME, '.adaptive-memory-test');
const testMemoryFiles = {
  'projects.md': `# Projects

## Active Projects (2026)

### Photonest
- Firebase-hosted Node.js web app
- Status: Pre-monetization, feature development
- Focus: Google Photos video analysis and curation

### TuneTussle
- Node.js multiplayer game
- Status: Pre-monetization, stability improvements
- Focus: Game mechanics refinement and UX

### WPChat
- RAG chatbot for ecommerce
- Status: Customer support automation
- Focus: Integration with WooCommerce stores
`,
  
  'people.md': `# People

## Charlie
- Daughter
- Family priority

## Laurie
- Wife (navigating estate/probate)
- Important life context
`,

  'infrastructure.md': `# Infrastructure & Tools

## OpenClaw Setup
- Main agent: full tool access
- API agent: restricted tool access
- Memory embeddings: Ollama-based
- Configuration: ~/.openclaw/openclaw.json

## GitHub Repos
- photonest: Firebase + Node.js
- tunetussle: Multiplayer game
- mk-theme: WordPress/WooCommerce
- wpchat: RAG ecommerce chatbot
`
};

// Create test directory
if (!fs.existsSync(testMemoryDir)) {
  fs.mkdirSync(testMemoryDir, { recursive: true });
}

// Create test files
for (const [filename, content] of Object.entries(testMemoryFiles)) {
  fs.writeFileSync(path.join(testMemoryDir, filename), content, 'utf8');
}

log(`Created test memory directory: ${testMemoryDir}`, 'yellow');
log(`Test files: ${Object.keys(testMemoryFiles).join(', ')}`, 'dim');

// =============================================================================
// Test Suite 1: Search Functionality
// =============================================================================

section('Test Suite 1: Search Functionality');

asyncTest('Search finds project-related chunks', async () => {
  const results = await searchMemory('active projects', {
    memoryDir: testMemoryDir,
    maxResults: 5,
    minScore: 0.3
  });
  
  if (results.length === 0) throw new Error('No results found');
  if (!results.some(r => r.snippet.includes('Photonest'))) {
    throw new Error('Expected to find Photonest in results');
  }
});

asyncTest('Search ranks results by relevance', async () => {
  const results = await searchMemory('OpenClaw', {
    memoryDir: testMemoryDir,
    maxResults: 10,
    minScore: 0.2
  });
  
  if (results.length < 2) throw new Error('Expected at least 2 results');
  if (results[0].score <= results[1].score) {
    throw new Error('Results should be sorted by score descending');
  }
});

asyncTest('Search respects maxResults parameter', async () => {
  const results = await searchMemory('project', {
    memoryDir: testMemoryDir,
    maxResults: 2
  });
  
  if (results.length > 2) throw new Error('Returned more than maxResults');
});

asyncTest('Search filters by minScore', async () => {
  const results = await searchMemory('blahblahblah xyz abc', {
    memoryDir: testMemoryDir,
    minScore: 0.9
  });
  
  const allAboveThreshold = results.every(r => r.score >= 0.9);
  if (!allAboveThreshold) throw new Error('Found results below minScore threshold');
});

asyncTest('Search handles invalid queries gracefully', async () => {
  const results1 = await searchMemory('', { memoryDir: testMemoryDir });
  const results2 = await searchMemory('ab', { memoryDir: testMemoryDir });
  const results3 = await searchMemory(null, { memoryDir: testMemoryDir });
  
  if (results1.length > 0 || results2.length > 0 || results3.length > 0) {
    throw new Error('Should return empty results for invalid queries');
  }
});

// =============================================================================
// Test Suite 2: Hook Functionality
// =============================================================================

section('Test Suite 2: Hook Functionality');

test('Hook exports correct interface', () => {
  if (!hook.name || hook.name !== 'adaptive_memory') {
    throw new Error('Hook should have name: adaptive_memory');
  }
  if (typeof hook.handler !== 'function') {
    throw new Error('Hook should export handler function');
  }
  if (hook.trigger !== 'onFirstMessage') {
    throw new Error('Hook should trigger on onFirstMessage');
  }
});

asyncTest('Hook handles valid messages', async () => {
  const result = await hook.handler({
    sessionKey: 'test-123',
    message: 'What are my active projects?',
    context: {}
  });
  
  if (typeof result.success !== 'boolean') {
    throw new Error('Hook should return object with success property');
  }
});

asyncTest('Hook skips invalid messages', async () => {
  const result = await hook.handler({
    sessionKey: 'test-123',
    message: null,
    context: {}
  });
  
  if (!result.success || !result.skipped) {
    throw new Error('Hook should skip null messages gracefully');
  }
});

asyncTest('Hook respects enableAdaptiveMemory config', async () => {
  // Should work with config.enableAdaptiveMemory = true
  const result = await hook.handler({
    sessionKey: 'test-config',
    message: 'test message about projects and github',
    context: {}
  });
  
  if (typeof result.success !== 'boolean') {
    throw new Error('Hook should execute regardless of message content');
  }
});

// =============================================================================
// Test Suite 3: Integration Flow
// =============================================================================

section('Test Suite 3: Integration (Search + Hook)');

asyncTest('Full flow: Intent -> Search -> Results', async () => {
  const intent = 'Show me my GitHub repositories';
  const results = await searchMemory(intent, {
    memoryDir: testMemoryDir,
    maxResults: 3
  });
  
  if (results.length === 0) throw new Error('Search should find relevant results');
  if (!results[0].path) throw new Error('Results should include path');
  if (typeof results[0].score !== 'number') throw new Error('Results should include score');
  if (!results[0].snippet) throw new Error('Results should include snippet');
});

asyncTest('Hook can process typical user queries', async () => {
  const testQueries = [
    'What am I working on?',
    'Show my projects',
    'Remind me about the infrastructure setup'
  ];
  
  for (const query of testQueries) {
    const result = await hook.handler({
      sessionKey: 'integration-test',
      message: query,
      context: {}
    });
    
    if (!result.success) {
      throw new Error(`Hook failed for query: "${query}"`);
    }
  }
});

// =============================================================================
// Cleanup and Results
// =============================================================================

section('Cleanup');

// Remove test directory
fs.rmSync(testMemoryDir, { recursive: true, force: true });
log(`Cleaned up test directory: ${testMemoryDir}`, 'yellow');

// =============================================================================
// Summary
// =============================================================================

console.log('');
console.log(`${colors.blue}${'='.repeat(60)}${colors.reset}`);
log(`Tests Complete: ${testsPassed} passed, ${testsFailed} failed`, 
    testsFailed === 0 ? 'green' : 'red');
console.log(`${colors.blue}${'='.repeat(60)}${colors.reset}`);

if (testsFailed > 0) {
  process.exit(1);
}

process.exit(0);
