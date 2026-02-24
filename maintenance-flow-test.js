#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

async function run() {
  const root = path.join(os.tmpdir(), `adaptive-maint-flow-${Date.now()}`);
  const memoryDir = path.join(root, 'memory');
  await fsp.mkdir(memoryDir, { recursive: true });
  process.env.OPENCLAW_MEMORY_DIR = memoryDir;

  const hook = require('./hook.js');
  const handler = require('./hooks/adaptive-memory/handler.js');
  const hi = hook._internals;
  const hh = handler._internals;

  const today = new Date().toISOString().slice(0, 10);
  const dailyPath = path.join(memoryDir, `${today}.md`);
  const corePath = path.join(root, 'MEMORY.md');

  // 1) Simulate bloat
  await fsp.writeFile(dailyPath, `# Daily\n\n${'x'.repeat(9000)}\n`, 'utf8');
  await fsp.writeFile(corePath, `# Core\n\n${'y'.repeat(13000)}\n`, 'utf8');

  const signals = await hi.getMemoryMaintenanceSignals();
  assert.strictEqual(signals.anyBloated, true, 'expected bloated signals');
  assert.ok(signals.daily.bloated, 'expected daily bloat');
  assert.ok(signals.memory.bloated, 'expected core memory bloat');

  // 2) Add maintenance prompt
  const note = await hi.appendMaintenancePromptToDaily(signals);
  assert.ok(note.changed, 'expected maintenance note to be written');
  const withNote = await fsp.readFile(dailyPath, 'utf8');
  assert.ok(withNote.includes('adaptive-memory:maintenance:pending'), 'maintenance marker missing');

  // 3) Consent/decline parsing coverage
  assert.strictEqual(hh.isExplicitMemoryOptimizationConsent('yes, optimize memory files without losing anything'), true);
  assert.strictEqual(hh.isExplicitMemoryOptimizationDecline('no, do not optimize memory now'), true);
  assert.strictEqual(hh.isExplicitMemoryOptimizationConsent('hello there'), false);

  // 4) Optimize (lossless): archives created + core file compacted
  const optimized = await hi.optimizeCoreMemoryFiles();
  assert.strictEqual(optimized.changed, true, 'expected optimization to change files');
  const archiveDir = path.join(memoryDir, 'archive');
  const archiveEntries = await fsp.readdir(archiveDir);
  assert.ok(archiveEntries.length > 0, 'expected archive snapshots');
  const compactedCore = await fsp.readFile(corePath, 'utf8');
  assert.ok(compactedCore.includes('MEMORY.md (compacted)'), 'core memory not compacted');

  // 5) Clear maintenance prompt after action
  const cleared = await hi.clearMaintenancePromptFromDaily();
  assert.ok(cleared.changed, 'expected maintenance note cleanup');
  const finalDaily = await fsp.readFile(dailyPath, 'utf8');
  assert.ok(!finalDaily.includes('adaptive-memory:maintenance:pending'), 'maintenance marker should be removed');

  // 6) Structured message normalization
  const structured = [{ type: 'text', text: 'yes, optimize memory files' }];
  assert.strictEqual(hh.normalizeMessageContent(structured), 'yes, optimize memory files');

  console.log('maintenance-flow-test: PASS');
}

run().catch((err) => {
  console.error('maintenance-flow-test: FAIL');
  console.error(err);
  process.exit(1);
});

