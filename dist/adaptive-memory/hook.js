#!/usr/bin/env node

/**
 * Adaptive Memory Hook (v0.3)
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
const { searchMemory, warmSearchCache } = require('./search.js');
const { expandPath, resolveMemoryDir } = require('./utils');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULTS = {
  enableAdaptiveMemory: true,
  searchTopK: 3,
  maxResultsPerSearch: 12,
  minRelevanceScore: 0.55,
  fallbackBehavior: 'continue_without_context',
  enableLogging: true,
  logLevel: 'info',
  coreMemoryPath: null,

  memoryDir: resolveMemoryDir(),

  // Injection budget caps
  maxInjectedCharsTotal: 4000,
  maxSnippetCharsEach: 800,
};

function loadConfig(defaults, filePath) {
  try {
    if (!fs.existsSync(filePath)) return { ...defaults };
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    const merged = { ...defaults, ...parsed };
    // Preserve env-driven portability when config keeps default memoryDir.
    if (
      process.env.OPENCLAW_MEMORY_DIR &&
      (!Object.prototype.hasOwnProperty.call(parsed, 'memoryDir') || parsed.memoryDir === '~/.openclaw/memory')
    ) {
      merged.memoryDir = process.env.OPENCLAW_MEMORY_DIR;
    }
    merged.memoryDir = expandPath(merged.memoryDir);
    return merged;
  } catch (e) {
    console.warn('[adaptive-memory] config.json invalid; using defaults:', e.message);
    return { ...defaults };
  }
}

const CONFIG = loadConfig(DEFAULTS, path.join(__dirname, 'config.json'));
const STARTUP_DIGEST_MARKER_START = '<!-- adaptive-memory:digest:start -->';
const STARTUP_DIGEST_MARKER_END = '<!-- adaptive-memory:digest:end -->';
const DAILY_SECTION_RE = /<!-- adaptive-memory:session=[^>]*-->[\s\S]*?<!-- adaptive-memory:session:end -->\s*/g;
const MAINTENANCE_MARKER = '<!-- adaptive-memory:maintenance:pending -->';
const MAINTENANCE_END_MARKER = '<!-- adaptive-memory:maintenance:end -->';
const MAINTENANCE_SECTION_RE = /<!-- adaptive-memory:maintenance:pending -->[\s\S]*?<!-- adaptive-memory:maintenance:end -->\s*/g;

const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
function shouldLog(level) {
  if (!CONFIG.enableLogging) return false;
  const configured = String(CONFIG.logLevel || 'info').toLowerCase();
  const current = LOG_LEVELS[configured] || LOG_LEVELS.info;
  const target = LOG_LEVELS[level] || LOG_LEVELS.info;
  return target >= current;
}

function log(level, ...args) {
  if (!shouldLog(level)) return;
  if (level === 'error') console.error(...args);
  else if (level === 'warn') console.warn(...args);
  else console.log(...args);
}

/** One-time warning when memoryDir is missing or empty so installs catch wrong path early. */
let _memoryDirWarned = false;
function warnIfMemoryDirUnusable(memoryDir) {
  if (_memoryDirWarned || !memoryDir) return;
  try {
    const stat = fs.statSync(memoryDir);
    if (!stat.isDirectory()) {
      log('warn', '[adaptive-memory] memoryDir is not a directory:', memoryDir);
      log('warn', '[adaptive-memory] Set OPENCLAW_MEMORY_DIR or OPENCLAW_PROJECT_DIR (project root with memory/ subdir) so memory is found.');
      _memoryDirWarned = true;
    }
  } catch {
    log('warn', '[adaptive-memory] memoryDir missing or not readable:', memoryDir);
    log('warn', '[adaptive-memory] Set OPENCLAW_MEMORY_DIR or OPENCLAW_PROJECT_DIR (project root with memory/ subdir), or create the directory.');
    _memoryDirWarned = true;
  }
}

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
    /\b(my|mine|we|our|project|store|customer|repo|deploy|ship|launch|openclaw|clawbot|woocommerce|wordpress|shipster)\b/i.test(s);

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

  warnIfMemoryDirUnusable(CONFIG.memoryDir);

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
      maxResults: CONFIG.maxResultsPerSearch || Math.max(CONFIG.searchTopK * 3, 10),
      minScore: CONFIG.minRelevanceScore * 0.8,  // relaxed initial filter
      memoryDir: CONFIG.memoryDir,
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
    log('error', '[adaptive-memory] Hook error:', error);

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

  log('info', `[adaptive-memory] Injected ${chunks.length} chunks into ${memoryPath} (session: ${sessionKey})`);
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
  lines.push('<!-- adaptive-memory:session:end -->');
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
 * Sanitize session key for safe use inside an HTML comment marker.
 * Strips control chars, restricts to safe charset, collapses runs of
 * dashes (prevents `--` which breaks HTML comment syntax), truncates.
 */
function escapeMarker(s) {
  return String(s)
    .replace(/[^A-Za-z0-9._-]/g, '_')  // safe charset only
    .replace(/-{2,}/g, '-')             // collapse -- to single -
    .slice(0, 128);
}

function stripAdaptiveSections(content) {
  const sections = [];
  const stripped = content.replace(DAILY_SECTION_RE, (m) => {
    sections.push(m);
    return '';
  });
  return { stripped: stripped.trim(), sections };
}

function stripPriorDigest(content) {
  const start = content.indexOf(STARTUP_DIGEST_MARKER_START);
  const end = content.indexOf(STARTUP_DIGEST_MARKER_END);
  if (start === -1 || end === -1 || end < start) return content.trim();
  const before = content.slice(0, start).trim();
  const after = content.slice(end + STARTUP_DIGEST_MARKER_END.length).trim();
  return [before, after].filter(Boolean).join('\n\n').trim();
}

function stripMaintenancePrompt(content) {
  return String(content || '').replace(MAINTENANCE_SECTION_RE, '').trim();
}

function buildStartupDigestFromSections(sections) {
  if (!sections.length) return null;

  const intents = [];
  const srcCount = new Map();

  for (const section of sections) {
    const q = section.match(/^\s*Query:\s*(.+)$/m);
    if (q && q[1]) intents.push(q[1].trim());

    for (const line of section.matchAll(/^###\s+\d+\.\s+(.+?)\s+\(relevance:/gm)) {
      const src = line[1].trim();
      srcCount.set(src, (srcCount.get(src) || 0) + 1);
    }
  }

  const topSources = Array.from(srcCount.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([src, n]) => `- ${src} (${n} hit${n === 1 ? '' : 's'})`);

  const recentIntents = intents.slice(-4).map((s) => `- ${s.slice(0, 140)}`);
  const now = new Date().toISOString();

  const lines = [
    STARTUP_DIGEST_MARKER_START,
    '## Adaptive Memory Startup Digest (auto-compact)',
    `*Updated: ${now}*`,
    '',
    `Compacted ${sections.length} prior adaptive-memory injection block${sections.length === 1 ? '' : 's'} from today's file.`,
    '',
    '### Recent intents',
    ...(recentIntents.length ? recentIntents : ['- (none captured)']),
    '',
    '### Frequent memory sources',
    ...(topSources.length ? topSources : ['- (none captured)']),
    STARTUP_DIGEST_MARKER_END,
  ];

  return lines.join('\n');
}

/**
 * Keep today's daily memory file lean before a new/reset session starts.
 * Removes stale adaptive-memory per-session sections and replaces them with
 * a compact digest section.
 */
async function compactDailyMemoryForStartup() {
  const today = new Date().toISOString().slice(0, 10);
  const memoryPath = path.join(CONFIG.memoryDir, `${today}.md`);
  const existing = await readFileIfExists(memoryPath);
  if (!existing) return { changed: false, removedSections: 0 };

  const withoutDigest = stripMaintenancePrompt(stripPriorDigest(existing));
  const { stripped, sections } = stripAdaptiveSections(withoutDigest);
  if (sections.length === 0) return { changed: false, removedSections: 0 };

  const digest = buildStartupDigestFromSections(sections);
  const next = [stripped, digest].filter(Boolean).join('\n\n').trim();
  const tmp = `${memoryPath}.tmp.${crypto.randomBytes(6).toString('hex')}`;
  await fsp.writeFile(tmp, next, 'utf8');
  await fsp.rename(tmp, memoryPath);

  return { changed: true, removedSections: sections.length, path: memoryPath };
}

function extractTextFromSessionContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => (item && typeof item.text === 'string' ? item.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

function extractSessionHighlightsFromText(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  if (clean.length > 260) return `${clean.slice(0, 257)}...`;
  return clean;
}

/**
 * Build a compact cross-session digest from recent JSONL sessions.
 * Digest is written into memoryDir/session-digest.md for startup use.
 */
async function refreshSessionDigest(options = {}) {
  const maxSessions = options.maxSessions || 8;
  const digestPath = path.join(CONFIG.memoryDir, 'session-digest.md');
  const sessionsDir = path.join(os.homedir(), '.openclaw', 'agents', 'main', 'sessions');
  const digestStatePath = path.join(os.homedir(), '.openclaw', 'adaptive-memory-digest-state.json');
  let digestState = { fileMtimes: {} };
  try {
    digestState = JSON.parse(await fsp.readFile(digestStatePath, 'utf8'));
  } catch {}

  let files = [];
  try {
    const entries = await fsp.readdir(sessionsDir, { withFileTypes: true });
    files = entries
      .filter((e) => e.isFile() && e.name.endsWith('.jsonl') && !e.name.includes('.deleted.'))
      .map((e) => path.join(sessionsDir, e.name));
  } catch {
    return { changed: false, sessions: 0, reason: 'sessions_dir_unavailable' };
  }

  const stats = await Promise.all(files.map(async (p) => {
    try {
      const st = await fsp.stat(p);
      return { p, mtimeMs: st.mtimeMs };
    } catch {
      return null;
    }
  }));

  const selectedStats = stats
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, maxSessions);
  const selected = selectedStats.map((x) => x.p);
  const unchanged = selectedStats.every((x) => digestState.fileMtimes?.[x.p] === x.mtimeMs);
  if (unchanged) return { changed: false, sessions: selected.length, path: digestPath, reason: 'unchanged' };

  const topicCount = new Map();
  const decisions = [];
  const openThreads = [];

  for (const file of selected) {
    let raw = '';
    try {
      raw = await fsp.readFile(file, 'utf8');
    } catch {
      continue;
    }

    let lineCount = 0;
    for (const line of raw.split('\n')) {
      lineCount += 1;
      if (lineCount > 2000) break;
      if (!line.trim()) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed?.type !== 'message') continue;
      const msg = parsed.message || {};
      const role = msg.role;
      const text = extractTextFromSessionContent(msg.content);
      const sample = extractSessionHighlightsFromText(text);
      if (!sample) continue;

      if (role === 'user') {
        const words = sample
          .toLowerCase()
          .split(/\s+/)
          .map((w) => w.replace(/[^a-z0-9_-]/g, ''))
          .filter((w) => w.length >= 4 && !['that', 'this', 'with', 'from', 'what', 'when', 'where', 'have', 'your', 'about'].includes(w));
        for (const w of words) topicCount.set(w, (topicCount.get(w) || 0) + 1);
        if (/\?$/.test(sample) || /\b(open|follow[- ]?up|pending|blocker|next step)\b/i.test(sample)) {
          openThreads.push(sample);
        }
      }
      if (/\b(decided|decision|we will|plan to|agreed|next step|ship|launch)\b/i.test(sample)) {
        decisions.push(sample);
      }
    }
  }

  const topTopics = Array.from(topicCount.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([k, n]) => `- ${k} (${n})`);

  const unique = (arr, limit) => {
    const seen = new Set();
    const out = [];
    for (const x of arr) {
      if (!seen.has(x)) {
        seen.add(x);
        out.push(`- ${x}`);
      }
      if (out.length >= limit) break;
    }
    return out;
  };

  const lines = [
    '# Session Digest (auto-generated)',
    `*Updated: ${new Date().toISOString()} | sessions scanned: ${selected.length}*`,
    '',
    '## Active topics',
    ...(topTopics.length ? topTopics : ['- (none detected)']),
    '',
    '## Recent decisions',
    ...(unique(decisions, 8).length ? unique(decisions, 8) : ['- (none detected)']),
    '',
    '## Open threads',
    ...(unique(openThreads, 8).length ? unique(openThreads, 8) : ['- (none detected)']),
    '',
    '_This digest is intentionally compact for startup context._',
  ];

  await fsp.mkdir(CONFIG.memoryDir, { recursive: true });
  const next = lines.join('\n').slice(0, 8000);
  const prev = await readFileIfExists(digestPath);
  if (prev.trim() === next.trim()) return { changed: false, sessions: selected.length, path: digestPath };

  const tmp = `${digestPath}.tmp.${crypto.randomBytes(6).toString('hex')}`;
  await fsp.writeFile(tmp, next, 'utf8');
  await fsp.rename(tmp, digestPath);
  digestState.fileMtimes = Object.fromEntries(selectedStats.map((x) => [x.p, x.mtimeMs]));
  const dsTmp = `${digestStatePath}.tmp.${Date.now()}`;
  await fsp.writeFile(dsTmp, JSON.stringify(digestState), 'utf8');
  await fsp.rename(dsTmp, digestStatePath);
  return { changed: true, sessions: selected.length, path: digestPath };
}

async function prewarmAdaptiveCache() {
  return warmSearchCache({ memoryDir: CONFIG.memoryDir });
}

function getWorkspaceRootFromMemoryDir(memoryDir) {
  const norm = path.normalize(memoryDir);
  if (path.basename(norm) === 'memory') {
    return path.dirname(norm);
  }
  if (process.env.OPENCLAW_PROJECT_DIR) {
    return expandPath(process.env.OPENCLAW_PROJECT_DIR);
  }
  return path.dirname(norm);
}

function resolveCoreMemoryPath() {
  if (CONFIG.coreMemoryPath) return expandPath(CONFIG.coreMemoryPath);
  const memoryDir = CONFIG.memoryDir;
  const workspaceRoot = getWorkspaceRootFromMemoryDir(memoryDir);
  const candidates = [
    path.join(workspaceRoot, 'MEMORY.md'),
    path.join(memoryDir, 'MEMORY.md'),
    path.join(path.dirname(memoryDir), 'MEMORY.md'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return candidates[0];
}

async function getMemoryMaintenanceSignals() {
  const today = new Date().toISOString().slice(0, 10);
  const memoryPath = path.join(CONFIG.memoryDir, `${today}.md`);
  const coreMemoryPath = resolveCoreMemoryPath();

  const limits = {
    dailyBytes: 8000,
    memoryBytes: 12000,
  };

  const signals = {
    daily: { path: memoryPath, size: 0, bloated: false, exists: false },
    memory: { path: coreMemoryPath, size: 0, bloated: false, exists: false },
    limits,
  };

  try {
    const st = await fsp.stat(memoryPath);
    signals.daily.exists = true;
    signals.daily.size = st.size;
    signals.daily.bloated = st.size > limits.dailyBytes;
  } catch {}

  try {
    const st = await fsp.stat(coreMemoryPath);
    signals.memory.exists = true;
    signals.memory.size = st.size;
    signals.memory.bloated = st.size > limits.memoryBytes;
  } catch {}

  signals.anyBloated = signals.daily.bloated || signals.memory.bloated;
  return signals;
}

async function appendMaintenancePromptToDaily(signals) {
  if (!signals?.anyBloated) return { changed: false, reason: 'not_bloated' };
  const today = new Date().toISOString().slice(0, 10);
  const memoryPath = path.join(CONFIG.memoryDir, `${today}.md`);
  await fsp.mkdir(CONFIG.memoryDir, { recursive: true });
  const existing = await readFileIfExists(memoryPath);
  if (existing.includes(MAINTENANCE_MARKER)) return { changed: false, reason: 'already_present' };

  const lines = [
    MAINTENANCE_MARKER,
    '## Memory Maintenance Notice (auto-detected)',
    '',
    'Your memory files are getting larger than the configured comfort threshold.',
    '',
    '- I can optimize them in a **lossless** way (archive full snapshots first, then compact active files).',
    '- I will not run this without explicit permission.',
    '',
    'If you want this, reply with:',
    '`yes, optimize memory files`',
    '',
    `Observed sizes: daily=${signals.daily.size} bytes, MEMORY.md=${signals.memory.size} bytes`,
    '---',
    MAINTENANCE_END_MARKER,
  ];

  const next = existing ? `${existing}\n\n${lines.join('\n')}` : lines.join('\n');
  const tmp = `${memoryPath}.tmp.${crypto.randomBytes(6).toString('hex')}`;
  await fsp.writeFile(tmp, next, 'utf8');
  await fsp.rename(tmp, memoryPath);
  return { changed: true, path: memoryPath };
}

async function clearMaintenancePromptFromDaily() {
  const today = new Date().toISOString().slice(0, 10);
  const memoryPath = path.join(CONFIG.memoryDir, `${today}.md`);
  const existing = await readFileIfExists(memoryPath);
  if (!existing || !existing.includes(MAINTENANCE_MARKER)) return { changed: false };
  const next = stripMaintenancePrompt(existing);
  const tmp = `${memoryPath}.tmp.${crypto.randomBytes(6).toString('hex')}`;
  await fsp.writeFile(tmp, next, 'utf8');
  await fsp.rename(tmp, memoryPath);
  return { changed: true, path: memoryPath };
}

function buildCompactMemorySummary(raw) {
  const lines = raw.split('\n');
  const selected = [];
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    if (/^#{1,6}\s+/.test(s) || /^[-*]\s+/.test(s) || /^\d+\.\s+/.test(s)) {
      selected.push(line);
    }
    if (selected.length >= 120) break;
  }
  if (selected.length === 0) {
    const fallback = raw.replace(/\s+/g, ' ').trim().slice(0, 1800);
    return fallback ? [fallback] : ['(no summary content extracted)'];
  }
  return selected;
}

async function optimizeCoreMemoryFiles() {
  const signals = await getMemoryMaintenanceSignals();
  if (!signals.anyBloated) return { changed: false, reason: 'nothing_to_optimize' };

  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const archiveDir = path.join(CONFIG.memoryDir, 'archive');
  await fsp.mkdir(archiveDir, { recursive: true });

  const changed = [];

  if (signals.memory.bloated && signals.memory.exists) {
    const raw = await readFileIfExists(signals.memory.path);
    const archivePath = path.join(archiveDir, `MEMORY-full-${stamp}.md`);
    await fsp.writeFile(archivePath, raw, 'utf8');

    const summaryLines = buildCompactMemorySummary(raw);
    const compact = [
      '# MEMORY.md (compacted)',
      '',
      `Compacted at ${now.toISOString()} with explicit user permission.`,
      `Full snapshot archived at: ${archivePath}`,
      '',
      '## Active Summary',
      ...summaryLines,
      '',
      '## Notes',
      '- Historical details remain in the archive snapshot above.',
    ].join('\n');

    const tmp = `${signals.memory.path}.tmp.${crypto.randomBytes(6).toString('hex')}`;
    await fsp.writeFile(tmp, compact, 'utf8');
    await fsp.rename(tmp, signals.memory.path);
    changed.push({ type: 'MEMORY.md', archivePath, path: signals.memory.path });
  }

  if (signals.daily.bloated && signals.daily.exists) {
    const dailyRaw = await readFileIfExists(signals.daily.path);
    const dailyArchive = path.join(archiveDir, `daily-${path.basename(signals.daily.path, '.md')}-full-${stamp}.md`);
    await fsp.writeFile(dailyArchive, dailyRaw, 'utf8');
    const compacted = await compactDailyMemoryForStartup();
    changed.push({ type: 'daily', archivePath: dailyArchive, path: signals.daily.path, compacted });
  }

  return { changed: changed.length > 0, actions: changed };
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
    compactDailyMemoryForStartup,
    refreshSessionDigest,
    prewarmAdaptiveCache,
    getMemoryMaintenanceSignals,
    appendMaintenancePromptToDaily,
    clearMaintenancePromptFromDaily,
    optimizeCoreMemoryFiles,
    resolveCoreMemoryPath,
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
