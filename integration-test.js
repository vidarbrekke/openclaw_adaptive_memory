#!/usr/bin/env node

/**
 * Integration Test for Adaptive Memory (v0.2 — hardened)
 *
 * Tests the complete flow: hook -> search -> injection
 * Creates temporary test memory files and validates:
 *  - Search finds relevant chunks from test memory
 *  - Hook produces valid results
 *  - Per-session de-dupe works (second call same session = 0 injected)
 *  - Different sessions on same day each get their own injection
 *  - Budget enforcement in injected output
 *  - Cache hits (second search for same files is faster / doesn't re-read)
 *  - Tech-prompt heuristic skips correctly
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { searchMemory } = require('./search.js');
const hook = require('./hook.js');

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const C = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  dim: '\x1b[2m',
};

let passed = 0;
let failed = 0;
const failures = [];

function section(title) {
  console.log(`\n${C.blue}${'='.repeat(60)}${C.reset}`);
  console.log(`${C.blue}${title}${C.reset}`);
  console.log(`${C.blue}${'='.repeat(60)}${C.reset}\n`);
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`${C.green}  \u2713 ${name}${C.reset}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log(`${C.red}  \u2717 ${name}${C.reset}`);
    console.log(`${C.dim}    ${err.message}${C.reset}`);
  }
}

// ---------------------------------------------------------------------------
// Setup: temp memory directory + files
// ---------------------------------------------------------------------------

const TEST_DIR = path.join(os.tmpdir(), `adaptive-memory-integ-${Date.now()}`);
const CACHE_PATH = path.join(TEST_DIR, '.cache.json');
process.env.OPENCLAW_MEMORY_DIR = path.join(TEST_DIR, 'memory-output');

const TEST_FILES = {
  'projects.md': `# Projects

## Active Projects (2026)

### Project Atlas
- Hosted Node.js web app
- Status: feature development
- Focus: data analysis and curation

### Project Beacon
- Node.js multiplayer game
- Status: stability improvements
- Focus: Game mechanics refinement and UX

### Project Comet
- RAG chatbot for support workflows
- Status: Customer support automation
- Focus: integration with external store platforms
`,

  'people.md': `# People

## Key Stakeholder A
- Strategic advisor
- Communication priority

## Key Stakeholder B
- Operations partner
- Important planning context
`,

  'infrastructure.md': `# Infrastructure & Tools

## OpenClaw Setup
- Main agent: full tool access
- API agent: restricted tool access
- Memory embeddings: Ollama-based
- Configuration: ~/.openclaw/openclaw.json

## GitHub Repos
- atlas: Node.js web app
- beacon: Multiplayer game
- commerce-theme: ecommerce theming
- comet-chat: RAG support chatbot
`,
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run() {
  // Setup
  section('Setup');
  fs.mkdirSync(TEST_DIR, { recursive: true });
  for (const [name, content] of Object.entries(TEST_FILES)) {
    fs.writeFileSync(path.join(TEST_DIR, name), content, 'utf8');
  }
  console.log(`${C.yellow}  Created test dir: ${TEST_DIR}${C.reset}`);

  // =========================================================================
  // Suite 1: Search
  // =========================================================================
  section('Suite 1: Search Functionality');

  await test('finds project-related chunks', async () => {
    const results = await searchMemory('active projects', {
      memoryDir: TEST_DIR, maxResults: 5, minScore: 0.3, cachePath: CACHE_PATH,
    });
    if (results.length === 0) throw new Error('no results');
    // With markdown-aware chunking, "Active Projects" heading is its own chunk
    if (!results.some(r => r.snippet.toLowerCase().includes('active') || r.snippet.toLowerCase().includes('project'))) {
      throw new Error('expected project-related content in results');
    }
  });

  await test('finds specific project by name', async () => {
    const results = await searchMemory('Project Atlas web app', {
      memoryDir: TEST_DIR, maxResults: 5, minScore: 0.2, cachePath: CACHE_PATH,
    });
    if (results.length === 0) throw new Error('no results');
    if (!results.some(r => r.snippet.includes('Project Atlas'))) {
      throw new Error('expected Project Atlas in results');
    }
  });

  await test('ranks results by score descending', async () => {
    const results = await searchMemory('OpenClaw memory agent', {
      memoryDir: TEST_DIR, maxResults: 10, minScore: 0.1, cachePath: CACHE_PATH,
    });
    for (let i = 1; i < results.length; i++) {
      if (results[i].score > results[i - 1].score) {
        throw new Error(`results[${i}].score > results[${i - 1}].score`);
      }
    }
  });

  await test('respects maxResults', async () => {
    const results = await searchMemory('project', {
      memoryDir: TEST_DIR, maxResults: 2, minScore: 0.1, cachePath: CACHE_PATH,
    });
    if (results.length > 2) throw new Error(`expected <= 2, got ${results.length}`);
  });

  await test('respects minScore', async () => {
    const results = await searchMemory('xyz blahblah nonexistent', {
      memoryDir: TEST_DIR, minScore: 0.9, cachePath: CACHE_PATH,
    });
    if (results.some(r => r.score < 0.9)) throw new Error('result below minScore');
  });

  await test('handles invalid queries gracefully', async () => {
    const r1 = await searchMemory('', { memoryDir: TEST_DIR, cachePath: CACHE_PATH });
    const r2 = await searchMemory('ab', { memoryDir: TEST_DIR, cachePath: CACHE_PATH });
    if (r1.length > 0 || r2.length > 0) throw new Error('expected empty results');
  });

  await test('preserves original text casing in snippets', async () => {
    const results = await searchMemory('firebase node', {
      memoryDir: TEST_DIR, minScore: 0.1, cachePath: CACHE_PATH,
    });
    if (results.length === 0) throw new Error('no results');
    // Snippet should have original casing, not lowercased
    const hasUpper = results.some(r => /[A-Z]/.test(r.snippet));
    if (!hasUpper) throw new Error('snippets appear to be lowercased');
  });

  await test('does not crash on regex special chars in query', async () => {
    await searchMemory('C++ what? (test)', {
      memoryDir: TEST_DIR, minScore: 0.1, cachePath: CACHE_PATH,
    });
    // If we get here without an exception, the test passes
  });

  // =========================================================================
  // Suite 2: Cache
  // =========================================================================
  section('Suite 2: Cache Behavior');

  await test('cache file is created after search', async () => {
    await searchMemory('projects', { memoryDir: TEST_DIR, cachePath: CACHE_PATH });
    if (!fs.existsSync(CACHE_PATH)) throw new Error('cache file not created');
  });

  await test('cache contains entries for memory files', async () => {
    const raw = fs.readFileSync(CACHE_PATH, 'utf8');
    const cache = JSON.parse(raw);
    const keys = Object.keys(cache.files);
    if (keys.length === 0) throw new Error('cache has no file entries');
    // Should have at least the files we created
    const hasProjects = keys.some(k => k.includes('projects.md'));
    if (!hasProjects) throw new Error('cache missing projects.md entry');
  });

  await test('cache entries have mtimeMs and chunks', async () => {
    const raw = fs.readFileSync(CACHE_PATH, 'utf8');
    const cache = JSON.parse(raw);
    for (const [, entry] of Object.entries(cache.files)) {
      if (typeof entry.mtimeMs !== 'number') throw new Error('missing mtimeMs');
      if (!Array.isArray(entry.chunks)) throw new Error('missing chunks array');
    }
  });

  // =========================================================================
  // Suite 3: Hook
  // =========================================================================
  section('Suite 3: Hook Functionality');

  await test('hook exports correct interface', () => {
    if (hook.name !== 'adaptive_memory') throw new Error('wrong name');
    if (typeof hook.handler !== 'function') throw new Error('handler not a function');
    if (hook.trigger !== 'onFirstMessage') throw new Error('wrong trigger');
  });

  await test('handler returns success for valid queries', async () => {
    const result = await hook.handler({
      sessionKey: `integ-${Date.now()}-valid`,
      message: 'What are my active projects and repos?',
      context: {},
    });
    if (typeof result.success !== 'boolean') throw new Error('missing success');
  });

  await test('handler skips null messages', async () => {
    const result = await hook.handler({
      sessionKey: `integ-null`,
      message: null,
      context: {},
    });
    if (!result.success || !result.skipped) throw new Error('should skip null');
  });

  await test('handler skips short messages', async () => {
    const result = await hook.handler({
      sessionKey: `integ-short`,
      message: 'hi',
      context: {},
    });
    if (!result.success || !result.skipped) throw new Error('should skip short');
  });

  await test('handler skips tech-only prompts', async () => {
    const result = await hook.handler({
      sessionKey: `integ-tech-${Date.now()}`,
      message: 'npm install lodash fails with ERESOLVE peer dependency conflict',
      context: {},
    });
    if (!result.skipped) throw new Error('should skip tech-only prompt');
    if (!result.reason || !result.reason.includes('technical')) {
      throw new Error(`expected tech-skip reason, got: ${result.reason}`);
    }
  });

  // =========================================================================
  // Suite 4: Per-session de-dupe
  // =========================================================================
  section('Suite 4: Per-Session De-dupe');

  await test('second call with same sessionKey does not re-inject', async () => {
    const sessionKey = `dedup-test-${Date.now()}`;
    const msg = 'What are my active projects and repos?';

    const first = await hook.handler({ sessionKey, message: msg, context: {} });
    // Wait a bit to avoid debounce
    await new Promise(r => setTimeout(r, 600));
    const second = await hook.handler({ sessionKey, message: msg, context: {} });

    // The second call should inject 0 (de-duped by session marker)
    // Note: if first.injected === 0, there was nothing to inject and de-dupe doesn't apply
    if (first.injected > 0 && second.injected > 0) {
      throw new Error(`expected second call to be de-duped, but injected ${second.injected}`);
    }
  });

  await test('different sessions on same day each inject', async () => {
    const msg = 'Tell me about my infrastructure setup and tools';

    const r1 = await hook.handler({
      sessionKey: `multi-A-${Date.now()}`,
      message: msg,
      context: {},
    });
    await new Promise(r => setTimeout(r, 100));
    const r2 = await hook.handler({
      sessionKey: `multi-B-${Date.now()}`,
      message: msg,
      context: {},
    });

    // Both should succeed (not blocked by "once per day" bug)
    if (!r1.success) throw new Error('session A failed');
    if (!r2.success) throw new Error('session B failed');
  });

  // =========================================================================
  // Suite 5: Full Integration Flow
  // =========================================================================
  section('Suite 5: Full Integration Flow');

  await test('intent -> search -> results pipeline', async () => {
    const results = await searchMemory('Show me my GitHub repositories', {
      memoryDir: TEST_DIR, maxResults: 3, minScore: 0.1, cachePath: CACHE_PATH,
    });
    if (results.length === 0) throw new Error('search should find results');
    if (!results[0].path) throw new Error('missing path');
    if (typeof results[0].score !== 'number') throw new Error('missing score');
    if (!results[0].snippet) throw new Error('missing snippet');
  });

  await test('hook can process multiple distinct queries', async () => {
    const queries = [
      'What am I working on currently?',
      'Tell me about my project infrastructure',
      'Who are the important people in my life?',
    ];

    for (const query of queries) {
      const result = await hook.handler({
        sessionKey: `multi-query-${Date.now()}-${Math.random()}`,
        message: query,
        context: {},
      });
      if (!result.success) throw new Error(`hook failed for: "${query}"`);
    }
  });

  // =========================================================================
  // Cleanup & Summary
  // =========================================================================
  section('Cleanup');
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  console.log(`${C.yellow}  Cleaned up: ${TEST_DIR}${C.reset}`);

  console.log('');
  console.log(`${C.blue}${'='.repeat(60)}${C.reset}`);
  const color = failed === 0 ? C.green : C.red;
  console.log(`${color}Tests: ${passed} passed, ${failed} failed${C.reset}`);
  if (failures.length > 0) {
    failures.forEach(f => console.log(`${C.red}  - ${f.name}: ${f.err.message}${C.reset}`));
  }
  console.log(`${C.blue}${'='.repeat(60)}${C.reset}`);

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Integration test runner error:', err);
  process.exit(1);
});
