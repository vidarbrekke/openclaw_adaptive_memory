# Adaptive Memory (On-Demand Context) — Hardening Plan (POC → v0.2)

*Design doc; implementation is in `hook.js` and `search.js`.*

**Purpose:** Your current POC aims to reduce “context pollution” at session start by **not loading broad personal/project memory up front**, and instead doing a **first-message-driven retrieval** (vector/keyword search) to inject only relevant context.

This document consolidates recommended improvements (robustness, scalability, efficiency) with a **minimal footprint** and **DRY/YAGNI** bias.

---

## Goals (keep these invariant)

1. **Bare-minimum context at session start**
   - No personal/project memory is preloaded.
2. **On-demand memory after the first user prompt**
   - Use the first prompt as the query for retrieval.
3. **Bounded injection**
   - Hard caps so injection can never explode context size.
4. **Safe + deterministic behavior**
   - Prevent duplicate injection.
   - Avoid data corruption on concurrent writes.
5. **Small footprint**
   - Minimal new files, minimal complexity, no “framework”.

---

## Current POC Issues (highest leverage first)

### 1) Injection de-dupe is currently “once per day”, not “once per session”
If you skip injection based on a generic marker like:

- `existingContent.includes('Adaptive Memory Context (auto-injected)')`

…then only the first session that day injects, and later sessions that day are blocked.

**Fix:** De-dupe with a session-specific marker (e.g., HTML comment) and check for that marker instead.

---

### 2) `sessionKey` should be used as the truth source for idempotency
Use `sessionKey` to:
- tag injected sections
- prevent duplicates (idempotent append)
- optionally store per-session state

---

### 3) Reading/chunking every memory file every new session won’t scale
The hot path should not:
- glob every file
- read every file
- split into chunks
- score every chunk

…on every new session.

**Smallest fix:** add a tiny persistent cache keyed by file mtime. Re-chunk only changed files.

---

### 4) Keyword scoring is brittle
Common pitfalls:
- `new RegExp(keyword)` breaks on regex characters (`+`, `?`, `(`, etc.)
- lowercasing content and returning it lowercased (bad UX)
- chunking that ignores markdown structure (headings)

**Fix:** escape regex, preserve original text for snippet, and chunk by headings/paragraphs with size caps.

---

### 5) “Intent extraction” needs basic hygiene
Naively taking the first N chars:
- includes code blocks/log dumps
- includes quoted content
- includes noise

**Fix:** strip fenced code blocks and normalize whitespace.

---

### 6) Debounce likely does not debounce
If you keep `_lastSearchTime` in a context object that isn’t persisted per-session, it may reset.

**Fix (YAGNI):** keep debounce in memory if OpenClaw guarantees it persists for session lifecycle; otherwise persist a tiny `state.json` per session in the session directory.

---

## Recommended Implementation (minimal footprint)

### Overview Flow

**Session Start**
- load bare minimum context only (no memory injection)

**First User Message**
1. Extract clean intent string
2. Optional heuristic: skip search for clearly technical prompts
3. Search memory store (vector/keyword)
4. Filter by score threshold
5. Inject top K chunks (budgeted, bounded)
6. Mark session as injected (idempotent)

---

## Drop-in Patch: `hook.js` (robust injection + bounded context)

> Adjust paths/exports to match your repo structure.

```js
// hook.js (patch-style)
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { searchMemory } = require('./search.js');

const DEFAULTS = {
  enableAdaptiveMemory: true,
  searchTopK: 3,
  minRelevanceScore: 0.5,
  debounceMs: 500,
  fallbackBehavior: 'continue_without_context',

  // Make memory location configurable and consistent
  memoryDir: path.join(os.homedir(), '.openclaw', 'memory'),

  // Caps: prevent injection from ballooning the context
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

  const now = Date.now();
  if (context._lastSearchTime && now - context._lastSearchTime < CONFIG.debounceMs) {
    return { success: true, debounced: true };
  }
  context._lastSearchTime = now;

  const intent = extractIntent(message);
  if (!intent) return { success: true, skipped: true, reason: 'Could not extract intent' };

  // Optional: avoid injecting personal/project memory into pure technical prompts
  if (!shouldSearchMemory(intent)) {
    return { success: true, skipped: true, reason: 'Heuristic: technical request; memory search skipped' };
  }

  const results = await searchMemory(intent, {
    maxResults: Math.max(CONFIG.searchTopK * 3, 10),
    minScore: CONFIG.minRelevanceScore * 0.8,
    memoryDir: CONFIG.memoryDir,
    useVectorSearch: true,
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
      preview: (c.snippet || '').slice(0, 120) + '…'
    }))
  };
}

function extractIntent(message) {
  if (!message || typeof message !== 'string') return null;

  // Remove fenced code blocks: they ruin search intent
  let s = message.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length < 10) return null;
  return s.slice(0, 280);
}

function shouldSearchMemory(intent) {
  const s = intent.toLowerCase();

  const looksLikeTech =
    s.includes('error') || s.includes('stack') || s.includes('trace') ||
    s.includes('npm ') || s.includes('pip ') || s.includes('docker') ||
    s.includes('bash') || s.includes('zsh') || s.includes('compile') ||
    /[{};<>]=|function\s*\(|class\s+/.test(s);

  const looksPersonalOrProject =
    /\b(my|mine|we|our|project|team|customer|product|repo|deployment)\b/.test(s);

  if (looksLikeTech && !looksPersonalOrProject) return false;
  return true;
}

async function injectMemoryChunks(sessionKey, intent, chunks) {
  const today = new Date().toISOString().slice(0, 10);
  const memoryPath = path.join(CONFIG.memoryDir, `${today}.md`);

  await fsp.mkdir(CONFIG.memoryDir, { recursive: true });

  const existing = await readFileIfExists(memoryPath);

  // De-dupe PER SESSION
  const marker = `<!-- adaptive-memory:session=${escapeMarker(sessionKey)} -->`;
  if (existing.includes(marker)) return 0;

  const ts = new Date().toISOString();
  const section = buildInjectionSection({ marker, sessionKey, intent, chunks, ts });

  // Atomic write: write temp file then rename
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

    const snippet = String(c.snippet || '').trim().slice(0, CONFIG.maxSnippetCharsEach);

    const take = snippet.slice(0, Math.max(0, budget));
    budget -= take.length;

    if (take) lines.push(take, '');
    if (budget <= 0) break;
  }

  lines.push('---');
  return lines.join('\n');
}

module.exports = {
  name: 'adaptive_memory',
  description: 'Load memory on-demand after first user prompt',
  trigger: 'onFirstMessage',
  handler: onFirstMessage
};
```

**What this gives you**
- correct per-session injection
- atomic writes (reduced risk of file corruption)
- bounded injection size
- optional technical-first-prompt skip (reduces irrelevant personal/project injection)

---

## Drop-in Patch: `search.js` (tiny persistent cache + safer scoring)

**Goal:** avoid reading and chunking the entire memory vault every new session.

### What’s added
- `~/.openclaw/adaptive-memory-cache.json`
- Cache keyed by file path and `mtimeMs`
- Chunk only changed files
- Escape regex in scoring

```js
// search.js (additions / refactor)
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const CACHE_PATH = path.join(os.homedir(), '.openclaw', 'adaptive-memory-cache.json');
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

  const coverage = hit / keywords.length;    // 0..1
  const repeats = bonus / keywords.length;   // small
  return Math.min(coverage * 0.85 + repeats * 0.3, 1.0);
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
          chunks: chunkTexts.map(t => ({ text: t, lc: t.toLowerCase() })),
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

// Your existing exported searchMemory() can call vectorSearchFiles()
// and keep the same signature you already use from hook.js
module.exports = {
  vectorSearchFiles,
  // searchMemory: (...) => { ... calls vectorSearchFiles ... }
};
```

**Notes**
- This keeps the footprint small: just one cache file.
- Chunk cap prevents runaway processing on huge docs.

---

## Config (keep it tiny, but do it)

Create `config.json` next to the hook:

```json
{
  "enableAdaptiveMemory": true,
  "memoryDir": "~/.openclaw/memory",
  "searchTopK": 3,
  "minRelevanceScore": 0.55,
  "maxInjectedCharsTotal": 4000,
  "maxSnippetCharsEach": 800,
  "debounceMs": 500
}
```

**Why:** avoids hard-coded paths and allows tuning without code edits.

---

## `/compact` (how to think about it)

`/compact` can reduce context size, but it’s **not a substitute** for not loading irrelevant memory.

**Recommended stance (YAGNI):**
- Implement on-demand memory injection first.
- Only consider `/compact` later if sessions still bloat after injection.

If you later add it:
- run `/compact` only after injection + first response
- verify it does not erase critical system rules or injected context

---

## Test Checklist (definition of done)

### Correctness
- ✅ New sessions on the same day each inject correctly (not blocked).
- ✅ Calling the hook twice for the same session does not duplicate injection.
- ✅ Missing memoryDir is created automatically.
- ✅ Injection is bounded (never exceeds budgets).

### Performance
- ✅ First run may be slower (cold cache), subsequent runs are fast.
- ✅ Large memory vault does not cause multi-second delays after cache warm-up.

### Relevance
- ✅ Tech-only first prompts skip memory search most of the time.
- ✅ Personal/project prompts pull relevant memory above threshold.

### Safety
- ✅ Concurrent runs don’t corrupt the memory file (atomic write pattern).
- ✅ Regex scoring doesn’t crash on special characters.

---

## Minimal Next Steps for the Developer

1. **Integrate `config.json`** and update path handling to be consistent across hook/search.
2. **Fix per-session de-dupe** (session marker).
3. **Add bounded injection budgets** (caps).
4. **Add cache file** (mtime-based) and stop reading/chunking all files every time.
5. **Harden scoring** (escape regex, stable normalization).
6. **Add skip heuristic** to reduce irrelevant injection.
7. **Write 5–10 unit-ish tests** (or lightweight harness) around:
   - intent extraction
   - de-dupe marker
   - budget enforcement
   - cache hit/miss behavior
   - scoring stability with regex chars

---

## Optional (only if needed later)

- Per-session state file (e.g., `session/.adaptive-memory-state.json`) if OpenClaw does not preserve `context` across hook invocations.
- Upgrade keyword scoring to “real” embeddings only if:
  - cache + heuristic still yields poor relevance
  - latency is acceptable
  - you can manage model/runtime footprint

---

## What to ask you (owner) for before expanding scope

- Where is the **session directory** located (if you want per-session `state.json`)?
- What is the **canonical memory source** (daily `.md`, multiple `.md`, a vault folder, etc.)?
- Is memory injection meant to go into:
  - the OpenClaw session context,
  - a memory markdown log,
  - or both?

Keep those answers as constraints to avoid feature creep.

---
