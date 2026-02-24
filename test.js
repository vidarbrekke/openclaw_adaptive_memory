#!/usr/bin/env node

/**
 * Unit Test Suite for Adaptive Memory (v0.3)
 *
 * Tests:
 *  - Intent extraction (code block stripping, whitespace normalization)
 *  - Session de-dupe marker (escaping, uniqueness)
 *  - Injection budget enforcement (total cap, per-snippet cap)
 *  - Regex escaping & keyword scoring stability
 *  - Markdown-aware chunking
 *  - Cache hit/miss behavior
 *  - Tech-prompt heuristic
 *  - Hook export structure & handler contract
 */

const assert = require('assert');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

// Isolate hook injection output from the user's real OpenClaw memory
const TEST_OUTPUT_DIR = path.join(os.tmpdir(), `adaptive-memory-unit-${Date.now()}`);
process.env.OPENCLAW_MEMORY_DIR = TEST_OUTPUT_DIR;

const hook = require('./hook.js');
const { searchMemory, getMemoryFiles, _internals: searchInternals } = require('./search.js');
const {
  escapeRegex,
  extractKeywords,
  buildKeywordMatchers,
  scoreChunk,
  splitIntoChunks,
  expandPath,
  resolveMemoryDir,
  loadCache,
  saveCache,
  DAILY_INJECTION_RE,
} = searchInternals;

const {
  extractIntent,
  shouldSearchMemory,
  buildInjectionSection,
  escapeMarker,
  clearMaintenancePromptFromDaily,
} = hook._internals;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let testsRun = 0;
let testsPassed = 0;
let testsFailed = 0;
const failures = [];
const pendingTests = [];

function describe(name, fn) {
  console.log(`\n${name}`);
  console.log('\u2500'.repeat(60));
  fn();
}

function test(name, fn) {
  testsRun++;
  try {
    const result = fn();
    // Handle async tests
    if (result && typeof result.then === 'function') {
      pendingTests.push(result
        .then(() => { testsPassed++; console.log(`  \u2713 ${name}`); })
        .catch(err => { testsFailed++; failures.push({ name, err }); console.log(`  \u2717 ${name}: ${err.message}`); }));
      return;
    }
    testsPassed++;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    testsFailed++;
    failures.push({ name, err });
    console.log(`  \u2717 ${name}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// search.js — escapeRegex
// ---------------------------------------------------------------------------

describe('escapeRegex', () => {
  test('escapes regex metacharacters', () => {
    assert.strictEqual(escapeRegex('C++'), 'C\\+\\+');
    assert.strictEqual(escapeRegex('what?'), 'what\\?');
    assert.strictEqual(escapeRegex('a.b'), 'a\\.b');
    assert.strictEqual(escapeRegex('foo(bar)'), 'foo\\(bar\\)');
    assert.strictEqual(escapeRegex('[test]'), '\\[test\\]');
  });

  test('leaves safe strings unchanged', () => {
    assert.strictEqual(escapeRegex('hello'), 'hello');
    assert.strictEqual(escapeRegex('foo bar'), 'foo bar');
  });

  test('escaped string is safe in RegExp', () => {
    const dangerous = 'price is $100 (USD)';
    const re = new RegExp(escapeRegex(dangerous));
    assert.ok(re.test(dangerous));
  });
});

// ---------------------------------------------------------------------------
// search.js — extractKeywords
// ---------------------------------------------------------------------------

describe('extractKeywords', () => {
  test('extracts meaningful words', () => {
    const kw = extractKeywords('What are my active projects?');
    assert.ok(kw.includes('active'));
    assert.ok(kw.includes('projects'));
  });

  test('filters stop words', () => {
    const kw = extractKeywords('What are the main projects');
    assert.ok(!kw.includes('what'));
    assert.ok(!kw.includes('are'));
    assert.ok(!kw.includes('the'));
  });

  test('filters very short words', () => {
    const kw = extractKeywords('a b cd foo bar');
    assert.ok(!kw.includes('a'));
    assert.ok(!kw.includes('b'));
    assert.ok(!kw.includes('cd'));
    assert.ok(kw.includes('foo'));
    assert.ok(kw.includes('bar'));
  });

  test('preserves special identifiers', () => {
    const kw = extractKeywords('C++ node.js python');
    assert.ok(kw.includes('c++'));
    assert.ok(kw.includes('node.js'));
    assert.ok(kw.includes('python'));
  });
});

// ---------------------------------------------------------------------------
// search.js — scoreChunk
// ---------------------------------------------------------------------------

describe('scoreChunk', () => {
  test('returns 0 for no keywords', () => {
    assert.strictEqual(scoreChunk([], 'some text'), 0);
  });

  test('returns 0 when no keywords match', () => {
    const score = scoreChunk(['alpha', 'beta'], 'gamma delta epsilon');
    assert.strictEqual(score, 0);
  });

  test('returns positive score for partial match', () => {
    const score = scoreChunk(['project', 'firebase', 'deploy'], 'project using firebase for hosting');
    assert.ok(score > 0, `score should be > 0, got ${score}`);
    assert.ok(score <= 1, `score should be <= 1, got ${score}`);
  });

  test('higher score for more keyword coverage', () => {
    const low = scoreChunk(['project', 'firebase', 'deploy'], 'project overview');
    const high = scoreChunk(['project', 'firebase', 'deploy'], 'project firebase deploy now');
    assert.ok(high > low, `full coverage (${high}) should score higher than partial (${low})`);
  });

  test('does not crash on regex special characters', () => {
    const score = scoreChunk(['c++', 'what?', '(test)'], 'using c++ for what? a (test) case');
    assert.ok(typeof score === 'number');
    assert.ok(!isNaN(score));
  });

  test('matches keyword tokens with punctuation boundaries', () => {
    const score = scoreChunk(['node.js', '991.1', 'c++'], 'we use node.js, c++, and version 991.1');
    assert.ok(score > 0, `expected punctuated token matches, got ${score}`);
  });

  test('score never exceeds 1.0', () => {
    const score = scoreChunk(['project'], 'project project project project project');
    assert.ok(score <= 1.0, `score should not exceed 1.0, got ${score}`);
  });

  test('coverage gate: returns 0 when >=4 keywords but only 1 hits', () => {
    const score = scoreChunk(
      ['alpha', 'beta', 'gamma', 'delta'],
      'this text only mentions alpha once'
    );
    assert.strictEqual(score, 0, `expected 0 (coverage gate), got ${score}`);
  });

  test('coverage gate: allows >=2 hits with >=4 keywords', () => {
    const score = scoreChunk(
      ['alpha', 'beta', 'gamma', 'delta'],
      'alpha and beta are here'
    );
    assert.ok(score > 0, `expected > 0 with 2 hits, got ${score}`);
  });

  test('coverage gate: does not apply with <4 keywords', () => {
    const score = scoreChunk(['alpha', 'beta', 'gamma'], 'only alpha here');
    assert.ok(score > 0, `expected > 0 for <4 keywords with 1 hit, got ${score}`);
  });

  test('precompiled matchers produce identical score', () => {
    const keywords = ['node.js', 'c++', 'deploy'];
    const chunk = 'node.js deploy pipeline with c++ addon';
    const fromKeywords = scoreChunk(keywords, chunk);
    const fromMatchers = scoreChunk(buildKeywordMatchers(keywords), chunk);
    assert.strictEqual(fromMatchers, fromKeywords);
  });
});

// ---------------------------------------------------------------------------
// search.js — splitIntoChunks
// ---------------------------------------------------------------------------

describe('splitIntoChunks', () => {
  test('splits on markdown headings', () => {
    const md = '# Heading 1\nSome text\n\n# Heading 2\nMore text';
    const chunks = splitIntoChunks(md);
    assert.ok(chunks.length >= 2, `expected >= 2 chunks, got ${chunks.length}`);
  });

  test('respects max chunk length', () => {
    const longParagraph = 'x'.repeat(2000);
    const chunks = splitIntoChunks(longParagraph);
    for (const chunk of chunks) {
      // Allow some slack for joining
      assert.ok(chunk.length <= 2400, `chunk too long: ${chunk.length}`);
    }
  });

  test('caps number of chunks per file', () => {
    const manyHeadings = Array.from({ length: 300 }, (_, i) => `# H${i}\nText ${i}`).join('\n');
    const chunks = splitIntoChunks(manyHeadings);
    assert.ok(chunks.length <= 200, `expected <= 200 chunks, got ${chunks.length}`);
  });

  test('preserves original text casing', () => {
    const md = '# My Project\nSome CamelCase content here';
    const chunks = splitIntoChunks(md);
    assert.ok(chunks.some(c => c.includes('CamelCase')));
  });
});

// ---------------------------------------------------------------------------
// search.js — DAILY_INJECTION_RE (file exclusion)
// ---------------------------------------------------------------------------

describe('DAILY_INJECTION_RE', () => {
  test('matches YYYY-MM-DD.md filenames', () => {
    assert.ok(DAILY_INJECTION_RE.test('2026-02-11.md'));
    assert.ok(DAILY_INJECTION_RE.test('2025-01-01.md'));
  });

  test('does not match regular memory files', () => {
    assert.ok(!DAILY_INJECTION_RE.test('projects.md'));
    assert.ok(!DAILY_INJECTION_RE.test('my-notes-2026.md'));
    assert.ok(!DAILY_INJECTION_RE.test('2026-02-11.json'));
    assert.ok(!DAILY_INJECTION_RE.test('2026-02-11-notes.md'));
  });
});

describe('getMemoryFiles exclusions', () => {
  test('excludes archive directory from search corpus', async () => {
    const base = path.join(os.tmpdir(), `adaptive-memory-files-${Date.now()}`);
    const archiveDir = path.join(base, 'archive');
    await fsp.mkdir(archiveDir, { recursive: true });
    await fsp.writeFile(path.join(base, 'keep.md'), 'keep', 'utf8');
    await fsp.writeFile(path.join(archiveDir, 'old.md'), 'archive', 'utf8');
    const files = await getMemoryFiles(base);
    assert.ok(files.some((p) => p.endsWith('keep.md')));
    assert.ok(!files.some((p) => p.includes(`${path.sep}archive${path.sep}`)));
  });
});

// ---------------------------------------------------------------------------
// search.js — expandPath
// ---------------------------------------------------------------------------

describe('expandPath', () => {
  test('expands tilde to home directory', () => {
    const result = expandPath('~/foo');
    assert.ok(result.startsWith(os.homedir()));
    assert.ok(result.endsWith('/foo') || result.endsWith('\\foo'));
  });

  test('returns absolute paths unchanged', () => {
    assert.strictEqual(expandPath('/usr/local'), '/usr/local');
  });

  test('returns relative paths unchanged', () => {
    assert.strictEqual(expandPath('some/path'), 'some/path');
  });
});

// ---------------------------------------------------------------------------
// utils — resolveMemoryDir (portable memory path)
// ---------------------------------------------------------------------------

describe('resolveMemoryDir', () => {
  const savedEnv = {};

  function saveEnv() {
    savedEnv.OPENCLAW_MEMORY_DIR = process.env.OPENCLAW_MEMORY_DIR;
    savedEnv.OPENCLAW_PROJECT_DIR = process.env.OPENCLAW_PROJECT_DIR;
  }

  function restoreEnv() {
    if (savedEnv.OPENCLAW_MEMORY_DIR !== undefined) process.env.OPENCLAW_MEMORY_DIR = savedEnv.OPENCLAW_MEMORY_DIR;
    else delete process.env.OPENCLAW_MEMORY_DIR;
    if (savedEnv.OPENCLAW_PROJECT_DIR !== undefined) process.env.OPENCLAW_PROJECT_DIR = savedEnv.OPENCLAW_PROJECT_DIR;
    else delete process.env.OPENCLAW_PROJECT_DIR;
  }

  test('uses OPENCLAW_MEMORY_DIR when set', () => {
    saveEnv();
    process.env.OPENCLAW_MEMORY_DIR = '/custom/memory';
    delete process.env.OPENCLAW_PROJECT_DIR;
    assert.strictEqual(resolveMemoryDir(), '/custom/memory');
    restoreEnv();
  });

  test('uses OPENCLAW_PROJECT_DIR/memory when set and OPENCLAW_MEMORY_DIR unset', () => {
    saveEnv();
    delete process.env.OPENCLAW_MEMORY_DIR;
    process.env.OPENCLAW_PROJECT_DIR = '/path/to/clawd';
    assert.strictEqual(resolveMemoryDir(), path.join('/path', 'to', 'clawd', 'memory'));
    restoreEnv();
  });

  test('OPENCLAW_MEMORY_DIR wins over OPENCLAW_PROJECT_DIR', () => {
    saveEnv();
    process.env.OPENCLAW_MEMORY_DIR = '/explicit/memory';
    process.env.OPENCLAW_PROJECT_DIR = '/project';
    assert.strictEqual(resolveMemoryDir(), '/explicit/memory');
    restoreEnv();
  });

  test('falls back to ~/.openclaw/memory when neither env set', () => {
    saveEnv();
    delete process.env.OPENCLAW_MEMORY_DIR;
    delete process.env.OPENCLAW_PROJECT_DIR;
    const result = resolveMemoryDir();
    assert.ok(result.startsWith(os.homedir()));
    assert.ok(result.includes('.openclaw'));
    assert.ok(result.endsWith('memory') || result.endsWith(path.join('openclaw', 'memory').replace(/\\/g, path.sep)));
    restoreEnv();
  });
});

// ---------------------------------------------------------------------------
// search.js — cache round-trip
// ---------------------------------------------------------------------------

describe('cache persistence', () => {
  const tmpCachePath = path.join(os.tmpdir(), `adaptive-memory-test-cache-${Date.now()}.json`);

  test('saves and loads cache correctly', async () => {
    const original = { version: 1, files: { '/test/file.md': { mtimeMs: 12345, chunks: [] } } };
    await saveCache(original, tmpCachePath);
    const loaded = await loadCache(tmpCachePath);
    assert.deepStrictEqual(loaded, original);
    // Cleanup
    fs.unlinkSync(tmpCachePath);
  });

  test('loadCache returns empty cache for missing file', async () => {
    const cache = await loadCache('/nonexistent/cache.json');
    assert.deepStrictEqual(cache, { version: 1, files: {} });
  });
});

// ---------------------------------------------------------------------------
// hook.js — extractIntent
// ---------------------------------------------------------------------------

describe('extractIntent', () => {
  test('returns null for null/undefined/empty', () => {
    assert.strictEqual(extractIntent(null), null);
    assert.strictEqual(extractIntent(undefined), null);
    assert.strictEqual(extractIntent(''), null);
  });

  test('returns null for very short messages', () => {
    assert.strictEqual(extractIntent('hi'), null);
    assert.strictEqual(extractIntent('ok'), null);
  });

  test('strips fenced code blocks', () => {
    const msg = 'I have this error ```\nTypeError: undefined\nat line 42\n``` please help';
    const intent = extractIntent(msg);
    assert.ok(!intent.includes('TypeError'));
    assert.ok(!intent.includes('undefined'));
    assert.ok(intent.includes('error'));
    assert.ok(intent.includes('help'));
  });

  test('strips inline code', () => {
    const msg = 'How do I use `fs.readFileSync` in my project configuration?';
    const intent = extractIntent(msg);
    assert.ok(!intent.includes('fs.readFileSync'));
    assert.ok(intent.includes('project'));
  });

  test('normalizes whitespace', () => {
    const msg = 'Tell    me    about\n\n\nmy\n\nprojects please and more';
    const intent = extractIntent(msg);
    assert.ok(!intent.includes('  '));
    assert.ok(!intent.includes('\n'));
  });

  test('caps at 280 chars', () => {
    const msg = 'a'.repeat(500) + ' meaningful query text';
    const intent = extractIntent(msg);
    assert.ok(intent.length <= 280);
  });
});

// ---------------------------------------------------------------------------
// hook.js — shouldSearchMemory
// ---------------------------------------------------------------------------

describe('shouldSearchMemory (tech-skip heuristic)', () => {
  test('skips pure technical prompts', () => {
    assert.strictEqual(shouldSearchMemory('npm install lodash error ERESOLVE'), false);
    assert.strictEqual(shouldSearchMemory('docker compose up fails'), false);
    assert.strictEqual(shouldSearchMemory('bash script syntax error'), false);
  });

  test('allows personal/project prompts', () => {
    assert.strictEqual(shouldSearchMemory('What are my active projects?'), true);
    assert.strictEqual(shouldSearchMemory('Remind me about our deployment setup'), true);
    assert.strictEqual(shouldSearchMemory('How do we handle customer onboarding?'), true);
  });

  test('allows mixed tech+personal prompts', () => {
    assert.strictEqual(shouldSearchMemory('npm error in my project build'), true);
    assert.strictEqual(shouldSearchMemory('docker setup for our deploy pipeline'), true);
  });

  test('allows non-tech non-personal prompts', () => {
    assert.strictEqual(shouldSearchMemory('design a landing page for the app'), true);
  });
});

// ---------------------------------------------------------------------------
// hook.js — escapeMarker
// ---------------------------------------------------------------------------

describe('escapeMarker', () => {
  test('collapses double dashes to prevent HTML comment breakage', () => {
    const result = escapeMarker('session--123--test');
    assert.ok(!result.includes('--'), `should not contain --, got: ${result}`);
  });

  test('restricts to safe charset', () => {
    const result = escapeMarker('key\nnew<line>&foo>bar');
    assert.ok(/^[A-Za-z0-9._-]*$/.test(result), `unsafe chars in: ${result}`);
  });

  test('caps length at 128', () => {
    const result = escapeMarker('x'.repeat(300));
    assert.ok(result.length <= 128, `expected <= 128, got ${result.length}`);
  });

  test('handles null/undefined gracefully', () => {
    const result = escapeMarker(null);
    assert.strictEqual(typeof result, 'string');
  });
});

// ---------------------------------------------------------------------------
// hook.js — buildInjectionSection
// ---------------------------------------------------------------------------

describe('buildInjectionSection (budget enforcement)', () => {
  test('includes session marker', () => {
    const section = buildInjectionSection({
      marker: '<!-- test-marker -->',
      sessionKey: 'session-1',
      intent: 'test query',
      chunks: [{ path: '/test/file.md', score: 0.9, snippet: 'snippet text' }],
    });
    assert.ok(section.includes('<!-- test-marker -->'));
  });

  test('includes session key and intent', () => {
    const section = buildInjectionSection({
      marker: '<!-- m -->',
      sessionKey: 'session-42',
      intent: 'my test intent',
      chunks: [{ path: '/a.md', score: 0.8, snippet: 'content' }],
    });
    assert.ok(section.includes('session-42'));
    assert.ok(section.includes('my test intent'));
  });

  test('enforces maxInjectedCharsTotal budget', () => {
    const bigSnippet = 'x'.repeat(5000);
    const section = buildInjectionSection({
      marker: '<!-- m -->',
      sessionKey: 's',
      intent: 'q',
      chunks: [
        { path: '/a.md', score: 0.9, snippet: bigSnippet },
        { path: '/b.md', score: 0.8, snippet: bigSnippet },
      ],
    });
    // The total snippet content should be bounded, not contain 10000 chars of x
    const xCount = (section.match(/x/g) || []).length;
    assert.ok(xCount <= 4000, `expected <= 4000 x chars from budget, got ${xCount}`);
  });

  test('enforces maxSnippetCharsEach per snippet', () => {
    // Use 'W' — doesn't appear in template text or ISO timestamps (which end in 'Z')
    const bigSnippet = 'W'.repeat(2000);
    const section = buildInjectionSection({
      marker: '<!-- m -->',
      sessionKey: 's',
      intent: 'q',
      chunks: [{ path: '/a.md', score: 0.9, snippet: bigSnippet }],
    });
    const wCount = (section.match(/W/g) || []).length;
    assert.ok(wCount <= 800, `expected <= 800 W chars per snippet, got ${wCount}`);
  });
});

// ---------------------------------------------------------------------------
// hook.js — maintenance prompt markers
// ---------------------------------------------------------------------------

describe('maintenance prompt marker handling', () => {
  test('clearMaintenancePromptFromDaily strips marker-bounded section', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const dailyPath = path.join(TEST_OUTPUT_DIR, `${today}.md`);
    await fsp.mkdir(TEST_OUTPUT_DIR, { recursive: true });
    await fsp.writeFile(
      dailyPath,
      [
        '# Existing content',
        '',
        '<!-- adaptive-memory:maintenance:pending -->',
        'Notice line',
        // Intentionally omit legacy --- delimiter to validate end-marker behavior.
        '<!-- adaptive-memory:maintenance:end -->',
        '',
        '# Keep this line',
      ].join('\n'),
      'utf8'
    );

    await clearMaintenancePromptFromDaily();

    const after = await fsp.readFile(dailyPath, 'utf8');
    assert.ok(!after.includes('adaptive-memory:maintenance:pending'));
    assert.ok(!after.includes('adaptive-memory:maintenance:end'));
    assert.ok(after.includes('# Keep this line'));
  });
});

// ---------------------------------------------------------------------------
// hook.js — module exports
// ---------------------------------------------------------------------------

describe('Hook module exports', () => {
  test('exports correct structure', () => {
    assert.strictEqual(hook.name, 'adaptive_memory');
    assert.strictEqual(typeof hook.handler, 'function');
    assert.strictEqual(hook.trigger, 'onFirstMessage');
    assert.strictEqual(typeof hook.description, 'string');
  });

  test('handler returns object with success for valid input', async () => {
    const result = await hook.handler({
      sessionKey: `unit-test-${Date.now()}`,
      message: 'What are my active projects and repositories?',
      context: {},
    });
    assert.strictEqual(typeof result, 'object');
    assert.strictEqual(typeof result.success, 'boolean');
  });

  test('handler handles null message gracefully', async () => {
    const result = await hook.handler({
      sessionKey: 'unit-test-null',
      message: null,
      context: {},
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.skipped, true);
  });

  test('handler handles very short message gracefully', async () => {
    const result = await hook.handler({
      sessionKey: 'unit-test-short',
      message: 'hi',
      context: {},
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.skipped, true);
  });
});

// ---------------------------------------------------------------------------
// searchMemory public API
// ---------------------------------------------------------------------------

describe('searchMemory API', () => {
  test('returns empty array for empty query', async () => {
    const results = await searchMemory('');
    assert.deepStrictEqual(results, []);
  });

  test('returns empty array for short query', async () => {
    const results = await searchMemory('ab');
    assert.deepStrictEqual(results, []);
  });

  test('returns array for valid query', async () => {
    const results = await searchMemory('projects');
    assert.ok(Array.isArray(results));
  });

  test('respects maxResults option', async () => {
    const results = await searchMemory('projects', { maxResults: 2 });
    assert.ok(results.length <= 2);
  });

  test('all results have required fields', async () => {
    const results = await searchMemory('projects active', { minScore: 0.1 });
    for (const r of results) {
      assert.ok(typeof r.path === 'string', 'result missing path');
      assert.ok(typeof r.score === 'number', 'result missing score');
      assert.ok(typeof r.snippet === 'string', 'result missing snippet');
    }
  });
});

// ---------------------------------------------------------------------------
// Run & report
// ---------------------------------------------------------------------------

Promise.allSettled(pendingTests).then(() => {
  fs.rmSync(TEST_OUTPUT_DIR, { recursive: true, force: true });
  console.log('\n' + '='.repeat(60));
  console.log(`Tests: ${testsPassed}/${testsRun} passed`);
  if (testsFailed > 0) {
    console.log(`${testsFailed} test(s) failed`);
    failures.forEach(f => console.log(`  - ${f.name}: ${f.err.message}`));
    process.exit(1);
  } else {
    console.log('All tests passed!');
    process.exit(0);
  }
});
