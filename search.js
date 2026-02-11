#!/usr/bin/env node

/**
 * Adaptive Memory Search Module (v0.2 — hardened)
 *
 * Performs keyword search against OpenClaw memory files.
 * - mtime-based persistent cache (re-chunks only changed files)
 * - Markdown-aware chunking (split on headings, then paragraphs, with size caps)
 * - Escaped regex scoring (safe for special chars like C++, what?, etc.)
 * - Preserves original text casing (lowercased copy used only for matching)
 *
 * Supports both vector-based and keyword-based search strategies.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

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

/**
 * Expand ~ to home directory (cross-platform)
 */
function expandPath(filePath) {
  if (filePath && filePath.startsWith('~')) {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}

// ---------------------------------------------------------------------------
// Markdown-aware chunking
// ---------------------------------------------------------------------------

const MAX_CHUNK_LEN = 1200;
const MAX_CHUNKS_PER_FILE = 200;

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

/**
 * Score a chunk against extracted keywords.
 * Uses escaped regex with word boundaries for safe matching.
 * Returns 0..1 relevance score.
 */
function scoreChunk(keywords, chunkLower) {
  if (!keywords.length) return 0;

  let hits = 0;
  let bonus = 0;

  for (const word of keywords) {
    const re = new RegExp(`\\b${escapeRegex(word)}\\b`, 'g');
    const matches = chunkLower.match(re);
    if (matches && matches.length) {
      hits += 1;
      // Logarithmic bonus for repeated mentions (capped)
      bonus += Math.min(Math.log(matches.length + 1) * 0.2, 0.5);
    }
  }

  const coverage = hits / keywords.length;       // 0..1 — how many keywords matched
  const repeatBonus = bonus / keywords.length;    // small additional weight
  return Math.min(coverage * 0.85 + repeatBonus * 0.3, 1.0);
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

/**
 * Get all memory files (*.md, *.json) recursively from memoryDir.
 * Skips hidden directories.
 */
async function getMemoryFiles(memoryDir) {
  const dir = expandPath(memoryDir);
  const files = [];

  try {
    const items = await fsp.readdir(dir, { withFileTypes: true });

    for (const item of items) {
      const fullPath = path.join(dir, item.name);

      if (item.isDirectory()) {
        if (!item.name.startsWith('.')) {
          const sub = await getMemoryFiles(fullPath);
          files.push(...sub);
        }
      } else if (item.isFile() && (item.name.endsWith('.md') || item.name.endsWith('.json'))) {
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
  const results = [];

  if (keywords.length === 0) return results;

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
          chunks: chunkTexts.map(t => ({ text: t, lc: t.toLowerCase() })),
        };
        cache.files[key] = cached;
      }

      for (const ch of cached.chunks) {
        const score = scoreChunk(keywords, ch.lc);
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

  await saveCache(cache, cachePath);

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, maxResults);
}

/**
 * Fallback keyword search (no cache, simpler scoring).
 */
async function keywordSearchFiles(query, files, options = {}) {
  const { maxResults = 10, minScore = 0.5 } = options;
  const keywords = extractKeywords(query);
  const results = [];

  if (keywords.length === 0) return results;

  for (const filePath of files) {
    try {
      const content = await fsp.readFile(filePath, 'utf8');
      const chunks = splitIntoChunks(content);

      for (const chunk of chunks) {
        const score = scoreChunk(keywords, chunk.toLowerCase());
        if (score >= minScore) {
          results.push({
            path: filePath,
            score,
            snippet: chunk.slice(0, 500),
          });
        }
      }
    } catch {
      // Ignore unreadable files
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, maxResults);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Adaptive Memory search — find relevant memory chunks.
 *
 * @param {string} query - User's intent/question
 * @param {object} options - { maxResults, minScore, memoryDir, useVectorSearch, cachePath }
 * @returns {Promise<Array>} Ranked results with { path, score, snippet }
 */
async function searchMemory(query, options = {}) {
  const {
    maxResults = 10,
    minScore = 0.5,
    memoryDir = process.env.OPENCLAW_MEMORY_DIR || '~/.openclaw/memory',
    useVectorSearch = true,
    cachePath,
  } = options;

  if (!query || typeof query !== 'string' || query.length < 3) {
    return [];
  }

  const files = await getMemoryFiles(memoryDir);
  if (files.length === 0) return [];

  const searchFn = useVectorSearch ? vectorSearchFiles : keywordSearchFiles;
  return searchFn(query, files, { maxResults, minScore, cachePath });
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
  getMemoryFiles,
  vectorSearchFiles,
  keywordSearchFiles,
  // Exported for unit testing
  _internals: {
    escapeRegex,
    extractKeywords,
    scoreChunk,
    splitIntoChunks,
    expandPath,
    loadCache,
    saveCache,
  },
};
