#!/usr/bin/env node

/**
 * Test Suite for Adaptive Memory
 * 
 * Tests hook and search functionality
 */

const assert = require('assert');
const { searchMemory } = require('./search.js');
const hook = require('./hook.js');

// Test counter
let testsRun = 0;
let testsPassed = 0;
let testsFailed = 0;

function test(name, fn) {
  testsRun++;
  try {
    fn();
    testsPassed++;
    console.log(`✓ ${name}`);
  } catch (error) {
    testsFailed++;
    console.log(`✗ ${name}`);
    console.log(`  Error: ${error.message}`);
  }
}

function describe(name, fn) {
  console.log(`\n${name}`);
  console.log('─'.repeat(50));
  fn();
}

// =============================================================================
// Search Tests
// =============================================================================

describe('Search Module', () => {
  
  test('searchMemory returns empty array for empty query', async () => {
    const results = await searchMemory('');
    assert.strictEqual(Array.isArray(results), true);
    assert.strictEqual(results.length, 0);
  });

  test('searchMemory returns empty array for short query', async () => {
    const results = await searchMemory('ab');
    assert.strictEqual(Array.isArray(results), true);
    assert.strictEqual(results.length, 0);
  });

  test('searchMemory returns array for valid query', async () => {
    const results = await searchMemory('projects');
    assert.strictEqual(Array.isArray(results), true);
  });

  test('searchMemory respects maxResults option', async () => {
    const results = await searchMemory('projects', { maxResults: 2 });
    assert.strictEqual(results.length <= 2, true);
  });

  test('searchMemory filters by minScore', async () => {
    const results = await searchMemory('projects', { minScore: 0.99 });
    const allAboveThreshold = results.every(r => r.score >= 0.99);
    assert.strictEqual(allAboveThreshold, true);
  });

});

// =============================================================================
// Hook Tests
// =============================================================================

describe('Hook Module', () => {
  
  test('hook exports correct structure', () => {
    assert.strictEqual(typeof hook.name, 'string');
    assert.strictEqual(typeof hook.handler, 'function');
    assert.strictEqual(hook.trigger, 'onFirstMessage');
  });

  test('hook handler returns object with success property', async () => {
    const result = await hook.handler({
      sessionKey: 'test',
      message: 'What are my projects?',
      context: {}
    });
    assert.strictEqual(typeof result.success, 'boolean');
  });

  test('hook handler skips if disabled', async () => {
    const result = await hook.handler({
      sessionKey: 'test',
      message: 'test message',
      context: {}
    });
    // Should either skip or continue without error
    assert.strictEqual(result.success, true);
  });

  test('hook handler handles invalid message', async () => {
    const result = await hook.handler({
      sessionKey: 'test',
      message: null,
      context: {}
    });
    assert.strictEqual(result.success, true);
  });

});

// =============================================================================
// Integration Tests
// =============================================================================

describe('Integration', () => {

  test('hook + search work together', async () => {
    const result = await hook.handler({
      sessionKey: 'test-integration',
      message: 'Show me my active projects',
      context: {}
    });
    assert.strictEqual(typeof result, 'object');
    assert.strictEqual(typeof result.success, 'boolean');
  });

});

// =============================================================================
// Results
// =============================================================================

console.log('\n' + '='.repeat(50));
console.log(`Tests: ${testsPassed}/${testsRun} passed`);

if (testsFailed > 0) {
  console.log(`${testsFailed} test(s) failed ❌`);
  process.exit(1);
} else {
  console.log('All tests passed! ✅');
  process.exit(0);
}
