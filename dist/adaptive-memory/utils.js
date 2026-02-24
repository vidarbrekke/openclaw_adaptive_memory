const path = require('path');
const os = require('os');

/**
 * Expand a leading ~ to the user's home directory.
 */
function expandPath(filePath) {
  if (filePath && filePath.startsWith('~')) {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}

/** Default OpenClaw memory directory when not overridden by config. */
const DEFAULT_OPENCLAW_MEMORY = path.join(os.homedir(), '.openclaw', 'memory');

/**
 * Resolve the memory directory in a portable way (any OpenClaw instance, any machine).
 * Order: OPENCLAW_MEMORY_DIR > OPENCLAW_PROJECT_DIR/memory > ~/.openclaw/memory.
 * Use this for defaults so project-based installs (e.g. clawd with memory at project/memory/) work without hardcoding paths.
 */
function resolveMemoryDir() {
  if (process.env.OPENCLAW_MEMORY_DIR) {
    return expandPath(process.env.OPENCLAW_MEMORY_DIR);
  }
  if (process.env.OPENCLAW_PROJECT_DIR) {
    return path.join(expandPath(process.env.OPENCLAW_PROJECT_DIR), 'memory');
  }
  return DEFAULT_OPENCLAW_MEMORY;
}

module.exports = {
  expandPath,
  resolveMemoryDir,
  DEFAULT_OPENCLAW_MEMORY,
};
