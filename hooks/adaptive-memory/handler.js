const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const STATE_PATH = path.join(os.homedir(), '.openclaw', 'adaptive-memory-first-message-state.json');
const SESSION_MARKERS_DIR = path.join(os.homedir(), '.openclaw', 'adaptive-memory-first-message-sessions');
const MAINTENANCE_STATE_PATH = path.join(os.homedir(), '.openclaw', 'adaptive-memory-maintenance-state.json');
const HISTORY_LIMIT = 12;

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { sessions: {} };
  }
}

function saveState(state) {
  const dir = path.dirname(STATE_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${STATE_PATH}.tmp.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
  fs.renameSync(tmp, STATE_PATH);
}

function ensureSessionMarkersDir() {
  fs.mkdirSync(SESSION_MARKERS_DIR, { recursive: true });
}

function markerPathForSession(sessionKey) {
  const digest = crypto
    .createHash('sha256')
    .update(String(sessionKey || ''))
    .digest('hex');
  return path.join(SESSION_MARKERS_DIR, `${digest}.json`);
}

function hasProcessedSession(sessionKey) {
  try {
    return fs.existsSync(markerPathForSession(sessionKey));
  } catch {
    return false;
  }
}

function markProcessedSession(sessionKey) {
  ensureSessionMarkersDir();
  const markerPath = markerPathForSession(sessionKey);
  const tmp = `${markerPath}.tmp.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(tmp, JSON.stringify({ sessionKey: String(sessionKey), processedAt: Date.now() }), 'utf8');
  fs.renameSync(tmp, markerPath);
}

function clearProcessedSession(sessionKey) {
  try {
    fs.unlinkSync(markerPathForSession(sessionKey));
  } catch {}
}

function loadMaintenanceState() {
  try {
    return JSON.parse(fs.readFileSync(MAINTENANCE_STATE_PATH, 'utf8'));
  } catch {
    return { pendingConsent: false, lastPromptAt: 0, optimizedAt: 0, snoozeUntil: 0, declinedAt: 0 };
  }
}

function saveMaintenanceState(state) {
  const dir = path.dirname(MAINTENANCE_STATE_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${MAINTENANCE_STATE_PATH}.tmp.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
  fs.renameSync(tmp, MAINTENANCE_STATE_PATH);
}

function readSessionHistory(sessionKey) {
  try {
    const raw = execFileSync(
      'openclaw',
      ['sessions', 'history', String(sessionKey), '--json', '--limit', String(HISTORY_LIMIT)],
      { encoding: 'utf8', timeout: 7000 }
    );
    const parsed = JSON.parse(raw);
    const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
    return messages;
  } catch {
    return [];
  }
}

function sortByTimestampIfPresent(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const allHaveTs = messages.every((m) => m && (m.timestamp || m.createdAt));
  if (!allHaveTs) return [...messages].reverse();
  return [...messages].sort((a, b) => {
    const ta = Number(new Date(a.timestamp || a.createdAt).getTime()) || 0;
    const tb = Number(new Date(b.timestamp || b.createdAt).getTime()) || 0;
    return ta - tb;
  });
}

function normalizeMessageContent(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (!part) return '';
        if (typeof part === 'string') return part;
        if (typeof part.text === 'string') return part.text;
        if (typeof part.content === 'string') return part.content;
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
    return text;
  }
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text.trim();
    if (typeof content.content === 'string') return content.content.trim();
  }
  return '';
}

function getFirstUserMessage(sessionKey) {
  const messages = sortByTimestampIfPresent(readSessionHistory(sessionKey));
  for (const m of messages) {
    if (!m || m.role !== 'user') continue;
    const text = normalizeMessageContent(m.content);
    if (text) return text;
  }
  return null;
}

function getLatestUserMessage(sessionKey) {
  const messages = sortByTimestampIfPresent(readSessionHistory(sessionKey));
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user') {
      const text = normalizeMessageContent(m.content);
      if (text) return text;
    }
  }
  return null;
}

function isExplicitMemoryOptimizationConsent(message) {
  const s = String(message || '').toLowerCase();
  if (!s) return false;
  const yes = /\b(yes|yep|yeah|please|go ahead|do it|proceed|ok|okay)\b/.test(s);
  const action = /\b(optimi[sz]e|compact|prune|clean up|reduce|shrink)\b/.test(s);
  const target = /\b(memory|memories|memory files|core memory files)\b/.test(s);
  const safe = /\b(without losing|lossless|keep all|do not lose)\b/.test(s);
  return (yes && action && target) || (action && target && safe);
}

function isExplicitMemoryOptimizationDecline(message) {
  const s = String(message || '').toLowerCase();
  if (!s) return false;
  return /\b(no|not now|later|skip|cancel|don't|do not)\b/.test(s) &&
    /\b(optimi[sz]e|compact|prune|memory)\b/.test(s);
}

function _legacyNoop() {
  // Kept intentionally empty to preserve file structure for minimal diff risk.
  return null;
}
/*
  Legacy execSync-based helpers were replaced with execFileSync and
  ordering-safe history parsing to avoid shell injection and ordering bugs.
*/

/**
 * OpenClaw hook-pack adapter for adaptive memory.
 * Uses command events and runs exactly once per session.
 * Uses the first user message as the intent seed.
 */
async function adaptiveMemoryHandler(event) {
  if (!event) return;

  const hookModule = require('../../hook.js');
  const compactDailyMemoryForStartup = hookModule?._internals?.compactDailyMemoryForStartup;
  const refreshSessionDigest = hookModule?._internals?.refreshSessionDigest;
  const prewarmAdaptiveCache = hookModule?._internals?.prewarmAdaptiveCache;
  const getMemoryMaintenanceSignals = hookModule?._internals?.getMemoryMaintenanceSignals;
  const appendMaintenancePromptToDaily = hookModule?._internals?.appendMaintenancePromptToDaily;
  const optimizeCoreMemoryFiles = hookModule?._internals?.optimizeCoreMemoryFiles;
  const clearMaintenancePromptFromDaily = hookModule?._internals?.clearMaintenancePromptFromDaily;
  const maintenanceState = loadMaintenanceState();

  // Startup maintenance: prewarm search cache + refresh cross-session digest.
  if (event.type === 'gateway:startup') {
    try {
      if (typeof prewarmAdaptiveCache === 'function') {
        const warm = await prewarmAdaptiveCache();
        console.log('[adaptive-memory] cache warmup:', JSON.stringify(warm));
      }
      if (typeof refreshSessionDigest === 'function') {
        const digest = await refreshSessionDigest();
        console.log('[adaptive-memory] session digest refresh:', JSON.stringify(digest));
      }
      if (typeof getMemoryMaintenanceSignals === 'function' && typeof appendMaintenancePromptToDaily === 'function') {
        const signals = await getMemoryMaintenanceSignals();
        if (signals.anyBloated && !maintenanceState.pendingConsent && Date.now() >= (maintenanceState.snoozeUntil || 0)) {
          const note = await appendMaintenancePromptToDaily(signals);
          if (note?.changed) {
            maintenanceState.pendingConsent = true;
            maintenanceState.lastPromptAt = Date.now();
            saveMaintenanceState(maintenanceState);
            console.log('[adaptive-memory] maintenance prompt added:', JSON.stringify(note));
          }
        }
      }
    } catch (e) {
      console.warn('[adaptive-memory] startup maintenance failed:', e?.message || String(e));
    }
    return;
  }

  if (event.type !== 'command' || !event.sessionKey) return;

  // On new/reset: compact today's file, refresh digest, clear per-session marker.
  if (event.action === 'new' || event.action === 'reset') {
    try {
      if (typeof compactDailyMemoryForStartup === 'function') {
        const compacted = await compactDailyMemoryForStartup();
        if (compacted?.changed) {
          console.log('[adaptive-memory] compacted daily file:', JSON.stringify(compacted));
        }
      }
      if (typeof refreshSessionDigest === 'function') {
        const digest = await refreshSessionDigest();
        if (digest?.changed) {
          console.log('[adaptive-memory] refreshed session digest:', JSON.stringify(digest));
        }
      }
      if (typeof getMemoryMaintenanceSignals === 'function' && typeof appendMaintenancePromptToDaily === 'function') {
        const signals = await getMemoryMaintenanceSignals();
        if (signals.anyBloated && !maintenanceState.pendingConsent && Date.now() >= (maintenanceState.snoozeUntil || 0)) {
          const note = await appendMaintenancePromptToDaily(signals);
          if (note?.changed) {
            maintenanceState.pendingConsent = true;
            maintenanceState.lastPromptAt = Date.now();
            saveMaintenanceState(maintenanceState);
            console.log('[adaptive-memory] maintenance prompt added:', JSON.stringify(note));
          }
        }
      }
    } catch (e) {
      console.warn('[adaptive-memory] lifecycle maintenance failed:', e?.message || String(e));
    }
    clearProcessedSession(event.sessionKey);
    return;
  }
  // Ignore lifecycle commands where first-user injection is not useful.
  if (event.action === 'stop') return;

  // Consent-gated optimization flow.
  if (maintenanceState.pendingConsent && typeof optimizeCoreMemoryFiles === 'function') {
    const latestUser = getLatestUserMessage(event.sessionKey);
    if (isExplicitMemoryOptimizationConsent(latestUser)) {
      try {
        const result = await optimizeCoreMemoryFiles();
        console.log('[adaptive-memory] user-approved optimization:', JSON.stringify(result));
        maintenanceState.pendingConsent = false;
        maintenanceState.optimizedAt = Date.now();
        maintenanceState.snoozeUntil = 0;
        if (typeof clearMaintenancePromptFromDaily === 'function') {
          await clearMaintenancePromptFromDaily();
        }
        saveMaintenanceState(maintenanceState);
      } catch (e) {
        console.warn('[adaptive-memory] optimization failed:', e?.message || String(e));
      }
    } else if (isExplicitMemoryOptimizationDecline(latestUser)) {
      maintenanceState.pendingConsent = false;
      maintenanceState.declinedAt = Date.now();
      maintenanceState.snoozeUntil = Date.now() + 24 * 60 * 60 * 1000;
      if (typeof clearMaintenancePromptFromDaily === 'function') {
        await clearMaintenancePromptFromDaily();
      }
      saveMaintenanceState(maintenanceState);
      console.log('[adaptive-memory] optimization declined; snoozed for 24h');
    }
  }

  if (hasProcessedSession(event.sessionKey)) return;

  const firstUserMessage = getFirstUserMessage(event.sessionKey);
  if (!firstUserMessage) return;

  try {
    if (typeof hookModule?.handler === 'function') {
      await hookModule.handler({
        sessionKey: event.sessionKey,
        message: firstUserMessage,
        context: {},
      });
    }
  } finally {
    // Mark as processed whether or not injection found matches:
    // semantic target is "run once per session after first user request is available".
    markProcessedSession(event.sessionKey);
  }
}

module.exports = adaptiveMemoryHandler;
module.exports._internals = {
  normalizeMessageContent,
  isExplicitMemoryOptimizationConsent,
  isExplicitMemoryOptimizationDecline,
  sortByTimestampIfPresent,
  hasProcessedSession,
  markProcessedSession,
  clearProcessedSession,
};
