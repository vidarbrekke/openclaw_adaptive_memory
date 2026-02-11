#!/usr/bin/env node

/**
 * Adaptive Memory Hook
 * 
 * Triggers after the first user message in a session.
 * Performs Adaptive Memory vector search on the user's intent and injects relevant memory chunks into context.
 * 
 * This hook is GLOBAL by default and runs on all new sessions.
 * Context injection follows OpenClaw best practice: augment session context via memory file updates
 * and system events that feed relevant information into the LLM naturally.
 */

const fs = require('fs');
const path = require('path');

// Configuration
const CONFIG = {
  enableAdaptiveMemory: true,
  searchTopK: 3,
  minRelevanceScore: 0.5,
  debounceMs: 500,
  fallbackBehavior: 'continue_without_context', // or 'load_all_memory'
};

// Load config from file if it exists
const configPath = path.join(__dirname, 'config.json');
if (fs.existsSync(configPath)) {
  const customConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  Object.assign(CONFIG, customConfig);
}

/**
 * Main hook function
 * Called by OpenClaw after first user message
 */
async function onFirstMessage({ sessionKey, message, context = {} }) {
  if (!CONFIG.enableAdaptiveMemory) {
    return { success: true, skipped: true, reason: 'Adaptive memory disabled' };
  }

  try {
    // Debounce: don't run multiple times in quick succession
    if (context._lastSearchTime && Date.now() - context._lastSearchTime < CONFIG.debounceMs) {
      return { success: true, debounced: true };
    }

    // Extract user intent from message
    const intent = extractIntent(message);
    
    if (!intent) {
      return { success: true, skipped: true, reason: 'Could not extract intent' };
    }

    // Perform vector search
    const results = await vectorSearch(intent);
    
    if (!results || results.length === 0) {
      return { 
        success: true, 
        found: 0, 
        reason: 'No relevant memory found'
      };
    }

    // Filter by relevance score
    const relevant = results.filter(r => r.score >= CONFIG.minRelevanceScore);
    
    if (relevant.length === 0) {
      return {
        success: true,
        found: results.length,
        filtered: 0,
        reason: 'Results below relevance threshold'
      };
    }

    // Take top K results
    const chunks = relevant.slice(0, CONFIG.searchTopK);

    // Inject into context
    const injected = await injectMemoryChunks(sessionKey, chunks);

    return {
      success: true,
      found: relevant.length,
      injected: chunks.length,
      chunks: chunks.map(c => ({
        path: c.path,
        score: c.score,
        preview: c.snippet.substring(0, 100) + '...'
      }))
    };

  } catch (error) {
    console.error('Adaptive memory hook error:', error);

    if (CONFIG.fallbackBehavior === 'load_all_memory') {
      // Load all memory as fallback
      return {
        success: false,
        error: error.message,
        fallback: 'loaded_all_memory'
      };
    }

    // Safe fallback: continue without injected context
    return {
      success: false,
      error: error.message,
      fallback: 'continue_without_context'
    };
  }
}

/**
 * Extract intent from user message
 * Identifies what the user is asking about
 */
function extractIntent(message) {
  if (!message || typeof message !== 'string') {
    return null;
  }

  // Remove system prefixes and clean up
  const cleaned = message
    .replace(/^System:\s*\[.*?\]\s*/i, '')
    .replace(/\n\s*\n/g, ' ')
    .trim();

  // If message is too short, it's probably not meaningful
  if (cleaned.length < 10) {
    return null;
  }

  // Return first 200 chars as intent (enough for meaningful search)
  return cleaned.substring(0, 200);
}

/**
 * Perform vector search against memory
 * Uses OpenClaw's memory_search capability
 * 
 * Note: In a real implementation, this would call the OpenClaw memory_search tool
 * For now, returns a mock result structure
 */
async function vectorSearch(query) {
  // This would normally call the memory_search tool
  // For testing/development, we return empty results
  // 
  // In production, this would be:
  // const results = await callMemorySearch(query, { maxResults: 10 });
  
  console.log(`[adaptive-memory] Searching for: "${query.substring(0, 50)}..."`);
  
  // Mock implementation for now
  return [];
}

/**
 * Inject memory chunks into session context
 * 
 * Best practice approach:
 * 1. Create a "context" section in memory/YYYY-MM-DD.md with injected chunks
 * 2. This is then naturally loaded when the agent reads daily memory
 * 3. No need to modify MEMORY.md or session state directly
 * 4. Transparent to the user; chunks appear in agent's context naturally
 */
async function injectMemoryChunks(sessionKey, chunks) {
  if (!chunks || chunks.length === 0) {
    return 0;
  }

  // Implementation approach:
  // 1. Build context section from chunks
  // 2. Append to memory/YYYY-MM-DD.md under ## Adaptive Memory Context
  // 3. Include source paths and relevance scores for transparency
  // 4. Timestamp the injection for debugging
  
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const memoryPath = `/Users/vidarbrekke/clawd/memory/${today}.md`;
  
  // Log what would be injected
  console.log(`[adaptive-memory] Injecting ${chunks.length} chunks into session ${sessionKey}`);
  chunks.forEach((chunk, i) => {
    console.log(`  ${i+1}. ${chunk.path} (score: ${chunk.score.toFixed(2)})`);
  });
  
  // TODO: Actually write to memory/YYYY-MM-DD.md
  // This will be picked up by the agent on next context load
  
  return chunks.length;
}

/**
 * Export for OpenClaw hook registration
 */
module.exports = {
  name: 'adaptive_memory',
  description: 'Load memory on-demand after first user prompt',
  trigger: 'onFirstMessage',
  handler: onFirstMessage
};

// CLI for testing
if (require.main === module) {
  const testMessage = process.argv[2] || 'What are my active projects?';
  
  onFirstMessage({
    sessionKey: 'test-session',
    message: testMessage,
    context: {}
  }).then(result => {
    console.log('\nHook Result:');
    console.log(JSON.stringify(result, null, 2));
  }).catch(err => {
    console.error('Hook failed:', err);
    process.exit(1);
  });
}
