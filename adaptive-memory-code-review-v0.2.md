# Adaptive Memory Skill/Hook — Code Review (v0.2) + Minimal Patch Guidance

**Reviewed artifact:** `/mnt/data/Archive.zip` (hook.js, search.js, config.json, tests, docs)

This document consolidates **all feedback** and includes **concrete code guidance** your developer can apply with a **small footprint**, staying **DRY & YAGNI**.

---

## 0) Executive Summary

You’re close to a viable v0.2, but the current codebase has **critical correctness bugs** and **scalability issues** that will show up immediately in real usage:

- **Injection de-dupe is “once per day”**, not per session (and it falsely claims injection happened).
- **Debounce doesn’t work** (`_lastSearchTime` never set).
- **Config drift** (config.json says one thing; code does another).
- **Search scales poorly** (reads + chunks every file each run).
- **Regex scoring can crash** on normal prompts.
- **Tests are broken** (async not awaited → false positives).
- Docs describe behavior that doesn’t match reality.

The fixes below are **small but high-leverage**, and keep the project lightweight.

---

## 1) Critical Correctness Bugs (Fix These First)

### 1.1 Injection de-dupe bug: “once per day” instead of “once per session”

**Location:** `hook.js` → `injectMemoryChunks()`

```js
if (existingContent.includes('Adaptive Memory Context (auto-injected)')) {
  console.log(`[adaptive-memory] Context already injected for ${today}`);
  return chunks.length;
}
```

**Impact**
- Only the *first* session on a given date injects.
- Later sessions that day never inject even when relevant.
- The function **returns `chunks.length` even though it injected nothing**, corrupting logs/telemetry.

**Minimal Fix**
- Use a **session-specific marker** and de-dupe on that marker.
- If already injected for that session, return `0` (or `{ alreadyInjected: true }`).

---

### 1.2 Debounce doesn’t debounce

**Location:** `hook.js`

You check `context._lastSearchTime` but never set it, so the condition never triggers.

**Minimal Fix**
- Set `context._lastSearchTime = Date.now()` before running retrieval.

---

### 1.3 `sessionKey` isn’t used for idempotency or tagging

You pass `sessionKey` around but don’t use it to guarantee **idempotent injection** or to tag the inserted context.

**Minimal Fix**
- Include `sessionKey` in a marker and in the injected block header metadata.
- Use marker for de-dupe.

---

## 2) Config Drift (Operator thinks config works, but code ignores it)

**Problem**
- `config.json` contains settings like `memoryDir`, `useVectorSearch`, `maxResultsPerSearch`, etc.
- Code often hard-codes or ignores them.

**Impact**
- Hard to tune behavior.
- Changes in config don’t affect runtime → confusing.

**Minimal Fix**
- Load config once, merge with defaults, and thread through:
  - `memoryDir`
  - `useVectorSearch`
  - `maxResultsPerSearch` (or derived `searchTopK`)

---

## 3) Performance & Scalability (will degrade quickly)

### 3.1 Reading/chunking every file each search
**Location:** `search.js` (`getMemoryFiles()` recursion + read all files + split chunks)

**Impact**
- Latency grows linearly with memory size.
- Will quickly become multi-second on a real vault.

**Minimal Fix (Huge ROI, small footprint)**
- Add **tiny persistent cache** keyed by file path + `mtimeMs`:
  - store chunks (text or boundaries)
  - store `lc` (lowercased) version for scoring
- Only re-read/re-chunk files whose `mtimeMs` changed.

**One file**: `~/.clawd/adaptive-memory-cache.json`

---

### 3.2 Synchronous I/O in the hot path
Using `fs.readFileSync` / `readdirSync` in an event-driven environment blocks the Node loop.

**Minimal Fix**
- Switch to `fs.promises` variants in search path.

---

## 4) Relevance Scoring Fragility (crashes + low quality snippets)

### 4.1 Regex injection / crashes
**Location:** `keywordSearchFiles()` and `scoreChunk()`:

```js
new RegExp(keyword, 'g')
```

**Impact**
- Any keyword containing regex chars can crash or match incorrectly.

**Minimal Fix**
- Escape user keyword before regex creation: `escapeRegex()`.

---

### 4.2 Lowercasing destroys snippet quality
You lower-case the whole file and then store snippets from that lowercased content.

**Impact**
- Snippets lose formatting/casing; worse for user + model.

**Minimal Fix**
- Score using lowercased content, but keep original text for snippet output.

---

### 4.3 Chunking is too naive for markdown
Paragraph splitting ignores headings and content structure.

**Minimal Fix**
- Chunk by markdown headings first (`\n(?=#+\s)`), then paragraphs, with a size cap.

---

## 5) Privacy/Minimal Context Goal Not Fully Enforced

Your stated goal: avoid pulling personal/project memory for “pure tech” sessions.

**Current behavior:** always searches memory after first message.

**Minimal Fix**
Add a lightweight heuristic to skip memory search for clearly technical prompts unless personal/project signals exist.

Example signals:
- Tech: stack traces, error logs, shell commands, code syntax
- Personal/project: “my”, “our”, “project”, “store”, “Mother Knitter”, “Shipster”, “OpenClaw”

---

## 6) Atomicity & Data Safety

Current pattern: read existing file → append → write.
Two sessions injecting around the same time can overwrite each other.

**Minimal Fix**
- Write to temp file + rename (atomic replace), OR
- Use append + session marker, but prefer temp+rename for safety.

---

## 7) Tests are giving false confidence

### 7.1 Async tests not awaited
**Location:** `test.js` (likely)

```js
function test(name, fn) {
  fn(); // async fn returns promise, not awaited
}
```

**Impact**
- Async failures don’t fail tests.
- You get “green” runs with broken code.

**Minimal Fix**
- Make test runner async and `await fn()`.

---

## 8) Docs don’t match code (dangerous for agentic workflows)

Example: docs imply OpenClaw-native vector search tool usage while the code does filesystem scans.

**Minimal Fix**
- Align docs with reality:
  - “Searches local markdown memory vault with keyword/cheap-vector scoring”
  - Mention cache file and marker behavior.

---

# 9) Minimal Patch Set (v0.2 Punch List)

Do these in order. Each is small and independently testable:

1. **Fix per-session injection idempotency** using session marker.
2. **Fix debounce** by setting `_lastSearchTime`.
3. **Thread config through** (no hardcoded `memoryDir`).
4. **Escape regex** and preserve original snippet.
5. **Add cache** keyed by `mtimeMs`.
6. **Make injection atomic** (temp write + rename).
7. **Fix async tests** so failures fail.
8. **Add skip heuristic** to support “minimal personal context” goal.
9. **Update docs** to match.

---

# 10) Concrete Code Guidance (Minimal Footprint)

Below are patch-style snippets. Integrate to match your repo’s structure.

---

## 10.1 `hook.js` — session-scoped de-dupe + bounded injection + real debounce + optional skip heuristic

```js
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { searchMemory } = require('./search.js');

const DEFAULTS = {
  enableAdaptiveMemory: true,
  memoryDir: path.join(os.homedir(), 'clawd', 'memory'),

  searchTopK: 3,
  maxResultsPerSearch: 12,        // optional: derived from searchTopK
  minRelevanceScore: 0.55,

  debounceMs: 500,

  // injection budgets
  maxInjectedCharsTotal: 4000,
  maxSnippetCharsEach: 800,
};

const CONFIG = loadConfig(DEFAULTS, path.join(__dirname, 'config.json'));

function loadConfig(defaults, filePath) {
  try {
    if (!fs.existsSync(filePath)) return { ...defaults };
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...defaults, ...parsed };
  } catch (e) {
    console.warn('[adaptive-memory] config.json invalid; using defaults:', e.message);
    return { ...defaults };
  }
}

async function onFirstMessage({ sessionKey, message, context = {} }) {
  if (!CONFIG.enableAdaptiveMemory) {
    return { success: true, skipped: true, reason: 'Adaptive memory disabled' };
  }

  // Debounce that actually works
  const now = Date.now();
  if (context._lastSearchTime && now - context._lastSearchTime < CONFIG.debounceMs) {
    return { success: true, debounced: true };
  }
  context._lastSearchTime = now;

  const intent = extractIntent(message);
  if (!intent) {
    return { success: true, skipped: true, reason: 'Could not extract intent' };
  }

  // Optional: enforce the “minimal personal context” goal
  if (!shouldSearchMemory(intent)) {
    return { success: true, skipped: true, reason: 'Heuristic: technical request; memory search skipped' };
  }

  const maxResults = CONFIG.maxResultsPerSearch || Math.max(CONFIG.searchTopK * 3, 10);

  const results = await searchMemory(intent, {
    memoryDir: CONFIG.memoryDir,
    useVectorSearch: true,
    maxResults,
    minScore: CONFIG.minRelevanceScore * 0.8,
  });

  const relevant = results.filter(r => r.score >= CONFIG.minRelevanceScore);
  const chunks = relevant.slice(0, CONFIG.searchTopK);

  if (chunks.length === 0) {
    return { success: true, found: results.length, injected: 0, reason: 'No relevant memory above threshold' };
  }

  const injected = await injectMemoryChunks(sessionKey, intent, chunks);

  return {
    success: true,
    found: relevant.length,
    injected,
    chunks: chunks.map(c => ({
      path: c.path,
      score: c.score,
      preview: (c.snippet || '').slice(0, 120) + '…',
    })),
  };
}

function extractIntent(message) {
  if (!message || typeof message !== 'string') return null;

  // Strip fenced code blocks - keeps query clean
  let s = message.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length < 10) return null;
  return s.slice(0, 280);
}

// Very small heuristic, large value
function shouldSearchMemory(intent) {
  const s = intent.toLowerCase();

  const looksLikeTech =
    s.includes('error') || s.includes('stack') || s.includes('trace') ||
    s.includes('npm ') || s.includes('pip ') || s.includes('docker') ||
    s.includes('bash') || s.includes('zsh') ||
    /[{};<>]=|function\s*\(|class\s+/.test(s);

  const looksPersonalOrProject =
    /\b(my|mine|we|our|project|store|customer|shipster|mother knitter|openclaw)\b/.test(s);

  if (looksLikeTech && !looksPersonalOrProject) return false;
  return true;
}

async function injectMemoryChunks(sessionKey, intent, chunks) {
  const today = new Date().toISOString().slice(0, 10);
  const memoryPath = path.join(CONFIG.memoryDir, `${today}.md`);

  await fsp.mkdir(CONFIG.memoryDir, { recursive: true });

  const existing = await readFileIfExists(memoryPath);

  // Per-session marker (idempotent)
  const marker = `<!-- adaptive-memory:session=${escapeMarker(sessionKey)} -->`;
  if (existing.includes(marker)) {
    return 0; // IMPORTANT: do not claim injection happened
  }

  const ts = new Date().toISOString();
  const section = buildInjectionSection({ marker, sessionKey, intent, chunks, ts });

  // Atomic write: temp + rename
  const next = existing ? `${existing}\n\n${section}` : section;
  const tmp = `${memoryPath}.tmp.${crypto.randomBytes(6).toString('hex')}`;
  await fsp.writeFile(tmp, next, 'utf8');
  await fsp.rename(tmp, memoryPath);

  return chunks.length;
}

async function readFileIfExists(p) {
  try { return await fsp.readFile(p, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return ''; throw e; }
}

function escapeMarker(s) {
  return String(s).replace(/--/g, '—').slice(0, 200);
}

function buildInjectionSection({ marker, sessionKey, intent, chunks, ts }) {
  let budget = CONFIG.maxInjectedCharsTotal;

  const lines = [
    marker,
    '## Adaptive Memory Context (auto-injected)',
    `*Loaded at ${ts} | session: ${sessionKey}*`,
    '',
    `Query: ${intent}`,
    ''
  ];

  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const src = path.basename(c.path || 'unknown');

    lines.push(`### ${i + 1}. ${src} (relevance: ${(c.score * 100).toFixed(0)}%)`, '');

    const snippet = String(c.snippet || '')
      .trim()
      .slice(0, CONFIG.maxSnippetCharsEach);

    const take = snippet.slice(0, Math.max(0, budget));
    budget -= take.length;

    if (take) lines.push(take, '');
    if (budget <= 0) break;
  }

  lines.push('---');
  return lines.join('\n');
}

module.exports = { onFirstMessage };
```

---

## 10.2 `search.js` — add tiny persistent cache + regex safety + markdown-aware chunking

This implementation keeps the project lightweight:
- **one cache JSON file**
- no new dependencies
- incremental re-chunking by mtime

```js
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const CACHE_PATH = path.join(os.homedir(), '.clawd', 'adaptive-memory-cache.json');
const CACHE_DIR = path.dirname(CACHE_PATH);

async function loadCache() {
  try {
    const raw = await fsp.readFile(CACHE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return { version: 1, files: {} };
    return { version: 1, files: {} };
  }
}

async function saveCache(cache) {
  await fsp.mkdir(CACHE_DIR, { recursive: true });
  const tmp = `${CACHE_PATH}.tmp.${Date.now()}`;
  await fsp.writeFile(tmp, JSON.stringify(cache), 'utf8');
  await fsp.rename(tmp, CACHE_PATH);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractKeywords(query) {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map(w => w.replace(/[^a-z0-9_-]/g, ''))
    .filter(w => w.length > 2);
}

function splitIntoChunksMarkdown(content) {
  const maxLen = 1200;
  const blocks = content.split(/\n(?=#+\s)/g); // split before headings
  const chunks = [];

  for (const b of blocks) {
    const parts = b.split(/\n\n+/);
    let buf = '';
    for (const p of parts) {
      const candidate = buf ? `${buf}\n\n${p}` : p;
      if (candidate.length > maxLen) {
        if (buf.trim()) chunks.push(buf.trim());
        buf = p;
      } else {
        buf = candidate;
      }
    }
    if (buf.trim()) chunks.push(buf.trim());
  }

  return chunks;
}

function scoreChunkKeywords(keywords, chunkLower) {
  if (!keywords.length) return 0;

  let hit = 0;
  let bonus = 0;

  for (const w of keywords) {
    const re = new RegExp(`\\b${escapeRegex(w)}\\b`, 'g');
    const m = chunkLower.match(re);
    if (m && m.length) {
      hit += 1;
      bonus += Math.min(Math.log(m.length + 1) * 0.2, 0.5);
    }
  }

  const coverage = hit / keywords.length;
  const repeats = bonus / keywords.length;
  return Math.min(coverage * 0.85 + repeats * 0.3, 1.0);
}

async function getMemoryFiles(memoryDir) {
  const files = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(p);
      else if (ent.isFile() && (p.endsWith('.md') || p.endsWith('.txt'))) files.push(p);
    }
  }
  await walk(memoryDir);
  return files;
}

async function vectorSearchFiles(query, files, options) {
  const cache = await loadCache();
  const keywords = extractKeywords(query);
  const results = [];

  for (const filePath of files) {
    try {
      const st = await fsp.stat(filePath);
      const key = filePath;

      let cached = cache.files[key];
      if (!cached || cached.mtimeMs !== st.mtimeMs) {
        const content = await fsp.readFile(filePath, 'utf8');
        const chunkTexts = splitIntoChunksMarkdown(content).slice(0, 200); // hard cap

        cached = {
          mtimeMs: st.mtimeMs,
          chunks: chunkTexts.map(t => ({
            text: t,          // preserve original
            lc: t.toLowerCase()
          })),
        };
        cache.files[key] = cached;
      }

      for (const ch of cached.chunks) {
        const score = scoreChunkKeywords(keywords, ch.lc);
        if (score >= options.minScore) {
          results.push({
            path: filePath,
            score,
            snippet: ch.text.slice(0, 500),
          });
        }
      }
    } catch (e) {
      // ignore unreadable files
    }
  }

  await saveCache(cache);

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, options.maxResults);
}

async function searchMemory(query, opts) {
  const memoryDir = expandHome(opts.memoryDir);
  const files = await getMemoryFiles(memoryDir);

  const options = {
    maxResults: opts.maxResults ?? 12,
    minScore: opts.minScore ?? 0.4
  };

  return vectorSearchFiles(query, files, options);
}

function expandHome(p) {
  if (!p) return p;
  if (p.startsWith('~')) {
    return path.join(process.env.HOME || process.env.USERPROFILE, p.slice(1));
  }
  return p;
}

module.exports = { searchMemory };
```

---

## 10.3 Fix the test runner so async tests actually fail

```js
// test.js (minimal async-safe harness)
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

async function run() {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn(); // IMPORTANT
      console.log(`✅ ${t.name}`);
    } catch (e) {
      failed += 1;
      console.error(`❌ ${t.name}`);
      console.error(e);
    }
  }
  if (failed) process.exit(1);
}

module.exports = { test, run };
```

Then call `run()` at the end of the test file(s).

---

# 11) Suggested `config.json` (keep it small)

```json
{
  "enableAdaptiveMemory": true,
  "memoryDir": "~/clawd/memory",
  "searchTopK": 3,
  "maxResultsPerSearch": 12,
  "minRelevanceScore": 0.55,
  "maxInjectedCharsTotal": 4000,
  "maxSnippetCharsEach": 800,
  "debounceMs": 500
}
```

---

# 12) `/compact` Guidance (YAGNI stance)

`/compact` can reduce context size but does not replace “don’t inject irrelevant memory”.

Recommended:
- implement on-demand memory injection first
- only add `/compact` if sessions still bloat after injection
- verify `/compact` does not erase critical system rules

---

# 13) Definition of Done (Practical)

### Correctness
- ✅ New sessions on same day each inject (not blocked).
- ✅ Same session never duplicates injection.
- ✅ Already-injected session returns `injected=0`.
- ✅ Debounce blocks duplicate retrieval calls.

### Performance
- ✅ Cold run may be slower; warm run is fast due to cache.
- ✅ Memory vault size growth does not create linear latency spikes each session.

### Relevance / Privacy
- ✅ “Pure technical” first prompts skip memory search most of the time.
- ✅ Personal/project prompts retrieve relevant context above threshold.

### Safety
- ✅ Regex scoring never crashes on symbols.
- ✅ Concurrent injection does not corrupt memory files (atomic write).

---

# 14) Immediate “gotcha” to fix right now

Your current injection code claims injection occurred even when it skipped due to the day-level marker (`return chunks.length`).

Fixing this removes log confusion and avoids misleading future decisions (like auto-tuning thresholds).

---

# 15) Minimal Next Steps for the Developer

1. Implement **session marker de-dupe** + correct return values.
2. Implement **real debounce**.
3. Thread **config** through search/injection paths.
4. Add **regex escaping** and preserve original snippets.
5. Add **mtime cache** for chunking.
6. Use **atomic temp+rename** injection.
7. Fix **async tests**.
8. Update **docs** to match actual behavior.

---

End of document.
