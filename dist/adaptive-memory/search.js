#!/usr/bin/env node

/**
 * Adaptive Memory Search Module (v0.3)
 *
 * Performs keyword search against OpenClaw memory files.
 * - mtime-based persistent cache (re-chunks only changed files)
 * - Markdown-aware chunking (split on headings, then paragraphs, with size caps)
 * - Escaped regex scoring (safe for special chars like C++, what?, etc.)
 * - Preserves original text casing (lowercased copy used only for matching)
 *
 * Uses cached keyword scoring (single search path).
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { expandPath, resolveMemoryDir } = require('./utils');

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const DEFAULT_CACHE_DIR = path.join(os.homedir(), '.openclaw');
const DEFAULT_CACHE_PATH = path.join(DEFAULT_CACHE_DIR, 'adaptive-memory-cache.json');

async function loadCache(cachePath) {
  const p = cachePath || DEFAULT_CACHE_PATH;
  try {
    const raw = await fsp.readFile(p, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { version: 1, files: {} };
  }
}

async function saveCache(cache, cachePath) {
  const p = cachePath || DEFAULT_CACHE_PATH;
  const dir = path.dirname(p);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = `${p}.tmp.${Date.now()}`;
  await fsp.writeFile(tmp, JSON.stringify(cache), 'utf8');
  await fsp.rename(tmp, p);
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/**
 * Escape string for safe use inside a RegExp
 */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Markdown-aware chunking
// ---------------------------------------------------------------------------

const MAX_CHUNK_LEN = 1200;
const MAX_CHUNKS_PER_FILE = 200;
const MAX_CACHE_FILES = 500;
const MAX_CACHE_JSON_BYTES = 10 * 1024 * 1024;

/**
 * Split markdown content into chunks respecting heading boundaries.
 * Each chunk keeps its original casing and a lowercased copy for matching.
 */
function splitIntoChunks(content) {
  // Split before markdown headings (# / ## / ### etc.)
  const blocks = content.split(/\n(?=#+\s)/g);
  const chunks = [];

  for (const block of blocks) {
    const paragraphs = block.split(/\n\n+/);
    let buf = '';

    for (const para of paragraphs) {
      const candidate = buf ? `${buf}\n\n${para}` : para;
      if (candidate.length > MAX_CHUNK_LEN) {
        if (buf.trim()) chunks.push(buf.trim());
        buf = para;
      } else {
        buf = candidate;
      }
    }
    if (buf.trim()) chunks.push(buf.trim());
  }

  // Hard cap per file to prevent runaway processing
  return chunks.slice(0, MAX_CHUNKS_PER_FILE);
}

// ---------------------------------------------------------------------------
// Keyword extraction & scoring
// ---------------------------------------------------------------------------

// Common stop words to filter from search queries
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
  'her', 'was', 'one', 'our', 'out', 'has', 'have', 'been', 'some', 'them',
  'than', 'its', 'over', 'into', 'just', 'about', 'what', 'which', 'when',
  'make', 'like', 'how', 'each', 'from', 'this', 'that', 'with', 'they',
  'will', 'would', 'there', 'their', 'could', 'other', 'more', 'very',
  'after', 'most', 'also', 'made', 'then', 'many', 'before', 'should',
  'these', 'where', 'being', 'does', 'show', 'tell', 'give', 'help',
  'remind', 'please',
]);

/**
 * Extract meaningful keywords from a query string.
 * Filters stop words and very short words, lowercases.
 */
function extractKeywords(query) {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map(w => w.replace(/[^a-z0-9_+#.-]/g, ''))
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

function buildKeywordMatchers(keywords) {
  return keywords.map((word) => {
    const escaped = escapeRegex(word);
    const hasNonWord = /[^A-Za-z0-9_]/.test(word);
    const pattern = hasNonWord
      ? `(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`
      : `\\b${escaped}\\b`;
    return { word, re: new RegExp(pattern, 'g') };
  });
}

/**
 * Score a chunk against extracted keywords.
 * Uses escaped regex with word boundaries for safe matching.
 * Returns 0..1 relevance score.
 *
 * Coverage rule: when the query has >=4 keywords, at least 2 distinct
 * keywords must match — prevents a single strong keyword from passing.
 */
function scoreChunk(matchers, chunkLower) {
  if (!matchers.length) return 0;
  const compiled = typeof matchers[0] === 'string'
    ? buildKeywordMatchers(matchers)
    : matchers;
  if (!compiled.length) return 0;

  let hits = 0;
  let bonus = 0;

  for (const m of compiled) {
    const matches = chunkLower.match(m.re);
    if (matches && matches.length) {
      hits += 1;
      // Logarithmic bonus for repeated mentions (capped)
      bonus += Math.min(Math.log(matches.length + 1) * 0.2, 0.5);
    }
  }

  // Coverage gate: require >=2 distinct keyword hits for longer queries
  if (compiled.length >= 4 && hits < 2) return 0;

  const coverage = hits / compiled.length;       // 0..1 — how many keywords matched
  const repeatBonus = bonus / compiled.length;    // small additional weight
  return Math.min(coverage * 0.85 + repeatBonus * 0.3, 1.0);
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

/**
 * Pattern matching daily injection files (YYYY-MM-DD.md) written by the hook.
 * These are excluded from the search corpus to prevent feedback loops.
 */
const DAILY_INJECTION_RE = /^\d{4}-\d{2}-\d{2}\.md$/;

/**
 * Get memory files (*.md only) recursively from memoryDir.
 * Skips hidden directories and daily injection files (YYYY-MM-DD.md).
 */
async function getMemoryFiles(memoryDir) {
  const dir = expandPath(memoryDir);
  const files = [];

  try {
    const items = await fsp.readdir(dir, { withFileTypes: true });

    for (const item of items) {
      const fullPath = path.join(dir, item.name);

      if (item.isDirectory()) {
        if (!item.name.startsWith('.') && item.name !== 'archive') {
          const sub = await getMemoryFiles(fullPath);
          files.push(...sub);
        }
      } else if (
        item.isFile() &&
        item.name.endsWith('.md') &&
        !DAILY_INJECTION_RE.test(item.name)
      ) {
        files.push(fullPath);
      }
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error(`[adaptive-memory] Cannot read ${dir}:`, e.message);
    }
  }

  return files;
}

// ---------------------------------------------------------------------------
// Search implementations
// ---------------------------------------------------------------------------

/**
 * Primary search: keyword scoring with mtime-based cache.
 * Only re-reads and re-chunks files whose mtime has changed.
 */
async function vectorSearchFiles(query, files, options = {}) {
  const { maxResults = 10, minScore = 0.5, cachePath } = options;

  const cache = await loadCache(cachePath);
  const keywords = extractKeywords(query);
  const matchers = buildKeywordMatchers(keywords);
  const results = [];
  let dirty = false;

  if (matchers.length === 0) return results;

  // Build set of current file paths for pruning
  const currentPaths = new Set(files);

  for (const filePath of files) {
    try {
      const st = await fsp.stat(filePath);
      const key = filePath;
      let cached = cache.files[key];

      // Re-chunk only if file has changed since last cache
      if (!cached || cached.mtimeMs !== st.mtimeMs) {
        const content = await fsp.readFile(filePath, 'utf8');
        const chunkTexts = splitIntoChunks(content);

        cached = {
          mtimeMs: st.mtimeMs,
          chunks: chunkTexts.map(t => ({ text: t })),
        };
        cache.files[key] = cached;
        dirty = true;
      }

      for (const ch of cached.chunks) {
        const score = scoreChunk(matchers, String(ch.text || '').toLowerCase());
        if (score >= minScore) {
          results.push({
            path: filePath,
            score,
            snippet: ch.text.slice(0, 500),  // original casing preserved
          });
        }
      }
    } catch {
      // Ignore unreadable files
    }
  }

  // Prune cache entries for deleted/renamed files
  for (const key of Object.keys(cache.files)) {
    if (!currentPaths.has(key)) {
      delete cache.files[key];
      dirty = true;
    }
  }

  // Bound cache growth: keep most-recently-updated file entries.
  const keys = Object.keys(cache.files);
  if (keys.length > MAX_CACHE_FILES) {
    keys
      .sort((a, b) => (cache.files[b]?.mtimeMs || 0) - (cache.files[a]?.mtimeMs || 0))
      .slice(MAX_CACHE_FILES)
      .forEach((k) => {
        delete cache.files[k];
        dirty = true;
      });
  }

  if (dirty) {
    const approxBytes = Buffer.byteLength(JSON.stringify(cache), 'utf8');
    if (approxBytes > MAX_CACHE_JSON_BYTES) {
      const ordered = Object.keys(cache.files)
        .sort((a, b) => (cache.files[b]?.mtimeMs || 0) - (cache.files[a]?.mtimeMs || 0));
      while (ordered.length && Buffer.byteLength(JSON.stringify(cache), 'utf8') > MAX_CACHE_JSON_BYTES) {
        const drop = ordered.pop();
        if (!drop) break;
        delete cache.files[drop];
      }
    }
  }

  // Only write cache if something changed
  if (dirty) {
    await saveCache(cache, cachePath);
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, maxResults);
}

/**
 * Pre-warm the mtime/chunk cache without running any query scoring.
 * Useful on gateway startup to reduce first-search latency.
 *
 * @param {object} options - { memoryDir, cachePath }
 * @returns {Promise<object>} Stats for observability
 */
async function warmSearchCache(options = {}) {
  const { memoryDir = resolveMemoryDir(), cachePath } = options;
  const files = await getMemoryFiles(memoryDir);
  const cache = await loadCache(cachePath);
  let dirty = false;
  let refreshed = 0;
  let reused = 0;

  const currentPaths = new Set(files);

  for (const filePath of files) {
    try {
      const st = await fsp.stat(filePath);
      const key = filePath;
      let cached = cache.files[key];

      if (!cached || cached.mtimeMs !== st.mtimeMs) {
        const content = await fsp.readFile(filePath, 'utf8');
        const chunkTexts = splitIntoChunks(content);
        cache.files[key] = {
          mtimeMs: st.mtimeMs,
          chunks: chunkTexts.map(t => ({ text: t })),
        };
        dirty = true;
        refreshed += 1;
      } else {
        reused += 1;
      }
    } catch {
      // Ignore unreadable files during warmup.
    }
  }

  for (const key of Object.keys(cache.files)) {
    if (!currentPaths.has(key)) {
      delete cache.files[key];
      dirty = true;
    }
  }

  const keys = Object.keys(cache.files);
  if (keys.length > MAX_CACHE_FILES) {
    keys
      .sort((a, b) => (cache.files[b]?.mtimeMs || 0) - (cache.files[a]?.mtimeMs || 0))
      .slice(MAX_CACHE_FILES)
      .forEach((k) => {
        delete cache.files[k];
        dirty = true;
      });
  }
  if (dirty && Buffer.byteLength(JSON.stringify(cache), 'utf8') > MAX_CACHE_JSON_BYTES) {
    const ordered = Object.keys(cache.files)
      .sort((a, b) => (cache.files[b]?.mtimeMs || 0) - (cache.files[a]?.mtimeMs || 0));
    while (ordered.length && Buffer.byteLength(JSON.stringify(cache), 'utf8') > MAX_CACHE_JSON_BYTES) {
      const drop = ordered.pop();
      if (!drop) break;
      delete cache.files[drop];
      dirty = true;
    }
  }

  if (dirty) {
    await saveCache(cache, cachePath);
  }

  return {
    filesSeen: files.length,
    refreshed,
    reused,
    cacheWritten: dirty,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Adaptive Memory search — find relevant memory chunks.
 *
 * @param {string} query - User's intent/question
 * @param {object} options - { maxResults, minScore, memoryDir, cachePath }
 * @returns {Promise<Array>} Ranked results with { path, score, snippet }
 */
async function searchMemory(query, options = {}) {
  const {
    maxResults = 10,
    minScore = 0.5,
    memoryDir = resolveMemoryDir(),
    cachePath,
  } = options;

  if (!query || typeof query !== 'string' || query.length < 3) {
    return [];
  }

  const files = await getMemoryFiles(memoryDir);
  if (files.length === 0) return [];

  return vectorSearchFiles(query, files, { maxResults, minScore, cachePath });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (require.main === module) {
  const query = process.argv[2] || 'projects active';

  searchMemory(query, { maxResults: 5, minScore: 0.3 }).then(results => {
    console.log(`\nFound ${results.length} results:\n`);
    results.forEach((r, i) => {
      console.log(`${i + 1}. ${path.basename(r.path)} (score: ${r.score.toFixed(2)})`);
      console.log(`   ${r.snippet.slice(0, 120)}`);
      console.log();
    });
  }).catch(err => {
    console.error('Search failed:', err);
    process.exit(1);
  });
}

module.exports = {
  searchMemory,
  warmSearchCache,
  getMemoryFiles,
  vectorSearchFiles,
  // Exported for unit testing
  _internals: {
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
  },
};
