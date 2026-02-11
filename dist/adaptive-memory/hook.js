#!/usr/bin/env node

/**
 * Adaptive Memory Hook (v0.2 — hardened)
 *
 * Triggers after the first user message in a session.
 * Performs keyword search on user intent and injects relevant memory chunks.
 *
 * Hardening (v0.2):
 *  - Per-session de-dupe via session-specific HTML comment marker
 *  - Intent extraction strips fenced code blocks and normalizes whitespace
 *  - Bounded injection (max total chars + max per snippet)
 *  - Atomic file writes (temp + rename)
 *  - Heuristic to skip memory search for pure technical prompts
 *
 * This hook is GLOBAL by default and runs on all new sessions.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { searchMemory } = require('./search.js');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULTS = {
  enableAdaptiveMemory: true,
  searchTopK: 3,
  minRelevanceScore: 0.55,
  debounceMs: 500,
  fallbackBehavior: 'continue_without_context',

  memoryDir: process.env.OPENCLAW_MEMORY_DIR || path.join(os.homedir(), '.openclaw', 'memory'),

  // Injection budget caps
  maxInjectedCharsTotal: 4000,
  maxSnippetCharsEach: 800,
};

function loadConfig(defaults, filePath) {
  try {
    if (!fs.existsSync(filePath)) return { ...defaults };
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    // Expand ~ in memoryDir if present
    const merged = { ...defaults, ...parsed };
    if (merged.memoryDir && merged.memoryDir.startsWith('~')) {
      merged.memoryDir = path.join(os.homedir(), merged.memoryDir.slice(1));
    }
    return merged;
  } catch (e) {
    console.warn('[adaptive-memory] config.json invalid; using defaults:', e.message);
    return { ...defaults };
  }
}

const CONFIG = loadConfig(DEFAULTS, path.join(__dirname, 'config.json'));

// ---------------------------------------------------------------------------
// Intent extraction
// ---------------------------------------------------------------------------

/**
 * Extract a clean search intent from the user's first message.
 * Strips fenced code blocks, normalizes whitespace, and caps length.
 */
function extractIntent(message) {
  if (!message || typeof message !== 'string') return null;

  // Remove fenced code blocks — they're noise for intent detection
  let s = message.replace(/```[\s\S]*?```/g, ' ');
  // Remove inline code
  s = s.replace(/`[^`]+`/g, ' ');
  // Remove system prefixes
  s = s.replace(/^System:\s*\[.*?\]\s*/i, '');
  // Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();

  if (s.length < 10) return null;
  return s.slice(0, 280);
}

// ---------------------------------------------------------------------------
// Tech-prompt heuristic
// ---------------------------------------------------------------------------

/**
 * Decide whether memory search is likely to be useful.
 * Pure technical prompts (error traces, CLI commands, raw code) rarely benefit
 * from personal/project memory injection, so we skip the search.
 *
 * Returns true if memory search should proceed.
 */
function shouldSearchMemory(intent) {
  const s = intent.toLowerCase();

  const looksLikeTech =
    s.includes('error') || s.includes('stack') || s.includes('trace') ||
    s.includes('npm ') || s.includes('pip ') || s.includes('docker') ||
    s.includes('bash') || s.includes('zsh') || s.includes('compile') ||
    /[{};<>]=|function\s*\(|class\s+/.test(s);

  // If the prompt also references personal/project context, search anyway
  const looksPersonalOrProject =
    /\b(my|mine|we|our|project|store|customer|repo|deploy|ship|launch)\b/i.test(s);

  if (looksLikeTech && !looksPersonalOrProject) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Main hook
// ---------------------------------------------------------------------------

/**
 * Main hook function — called by OpenClaw after first user message.
 */
async function onFirstMessage({ sessionKey, message, context = {} }) {
  if (!CONFIG.enableAdaptiveMemory) {
    return { success: true, skipped: true, reason: 'Adaptive memory disabled' };
  }

  // Debounce
  const now = Date.now();
  if (context._lastSearchTime && now - context._lastSearchTime < CONFIG.debounceMs) {
    return { success: true, debounced: true };
  }
  context._lastSearchTime = now;

  try {
    const intent = extractIntent(message);
    if (!intent) {
      return { success: true, skipped: true, reason: 'Could not extract intent' };
    }

    // Heuristic: skip for purely technical prompts
    if (!shouldSearchMemory(intent)) {
      return { success: true, skipped: true, reason: 'Heuristic: technical-only prompt, memory search skipped' };
    }

    // Search memory — fetch more than needed, then filter
    const results = await searchMemory(intent, {
      maxResults: Math.max(CONFIG.searchTopK * 3, 10),
      minScore: CONFIG.minRelevanceScore * 0.8,  // relaxed initial filter
      memoryDir: CONFIG.memoryDir,
      useVectorSearch: true,
    });

    // Apply strict threshold
    const relevant = results.filter(r => r.score >= CONFIG.minRelevanceScore);
    const chunks = relevant.slice(0, CONFIG.searchTopK);

    if (chunks.length === 0) {
      return {
        success: true,
        found: results.length,
        injected: 0,
        reason: 'No relevant memory above threshold',
      };
    }

    // Inject into daily memory file
    const injected = await injectMemoryChunks(sessionKey, intent, chunks);

    return {
      success: true,
      found: relevant.length,
      injected,
      chunks: chunks.map(c => ({
        path: c.path,
        score: c.score,
        preview: (c.snippet || '').slice(0, 120) + '...',
      })),
    };
  } catch (error) {
    console.error('[adaptive-memory] Hook error:', error);

    if (CONFIG.fallbackBehavior === 'load_all_memory') {
      return { success: false, error: error.message, fallback: 'loaded_all_memory' };
    }
    return { success: false, error: error.message, fallback: 'continue_without_context' };
  }
}

// ---------------------------------------------------------------------------
// Injection
// ---------------------------------------------------------------------------

/**
 * Inject memory chunks into the daily memory file.
 * Uses a session-specific HTML comment marker for per-session de-dupe.
 * Uses atomic write (temp file + rename) to prevent corruption.
 */
async function injectMemoryChunks(sessionKey, intent, chunks) {
  if (!chunks || chunks.length === 0) return 0;

  const today = new Date().toISOString().slice(0, 10);
  const memoryPath = path.join(CONFIG.memoryDir, `${today}.md`);

  await fsp.mkdir(CONFIG.memoryDir, { recursive: true });

  const existing = await readFileIfExists(memoryPath);

  // Per-session de-dupe: check for session-specific marker
  const marker = `<!-- adaptive-memory:session=${escapeMarker(sessionKey)} -->`;
  if (existing.includes(marker)) return 0;

  const section = buildInjectionSection({ marker, sessionKey, intent, chunks });

  // Atomic write: temp file + rename
  const next = existing ? `${existing}\n\n${section}` : section;
  const tmp = `${memoryPath}.tmp.${crypto.randomBytes(6).toString('hex')}`;
  await fsp.writeFile(tmp, next, 'utf8');
  await fsp.rename(tmp, memoryPath);

  console.log(`[adaptive-memory] Injected ${chunks.length} chunks into ${memoryPath} (session: ${sessionKey})`);
  return chunks.length;
}

/**
 * Build the injection section with budget enforcement.
 * Stops adding snippets once the total character budget is exhausted.
 */
function buildInjectionSection({ marker, sessionKey, intent, chunks }) {
  const ts = new Date().toISOString();
  let budget = CONFIG.maxInjectedCharsTotal;

  const lines = [
    marker,
    '## Adaptive Memory Context (auto-injected)',
    `*Loaded at ${ts} | session: ${sessionKey}*`,
    '',
    `Query: ${intent}`,
    '',
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readFileIfExists(p) {
  try {
    return await fsp.readFile(p, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return '';
    throw e;
  }
}

/**
 * Escape session key for safe use inside an HTML comment.
 * Prevents `--` which would break the comment syntax.
 */
function escapeMarker(s) {
  return String(s).replace(/--/g, '\u2014').slice(0, 200);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  name: 'adaptive_memory',
  description: 'Load memory on-demand after first user prompt',
  trigger: 'onFirstMessage',
  handler: onFirstMessage,
  // Exported for unit testing
  _internals: {
    extractIntent,
    shouldSearchMemory,
    buildInjectionSection,
    escapeMarker,
    loadConfig,
    DEFAULTS,
  },
};

// ---------------------------------------------------------------------------
// CLI for manual testing
// ---------------------------------------------------------------------------

if (require.main === module) {
  const testMessage = process.argv[2] || 'What are my active projects?';

  onFirstMessage({
    sessionKey: `cli-test-${Date.now()}`,
    message: testMessage,
    context: {},
  }).then(result => {
    console.log('\nHook Result:');
    console.log(JSON.stringify(result, null, 2));
  }).catch(err => {
    console.error('Hook failed:', err);
    process.exit(1);
  });
}
