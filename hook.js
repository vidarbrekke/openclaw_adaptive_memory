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
const { searchMemory } = require('./search.js');

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
 * Perform vector search against memory using Adaptive Memory search module
 */
async function vectorSearch(query) {
  try {
    // Import the search module
    const { searchMemory } = require('./search.js');
    
    // Perform Adaptive Memory search
    const results = await searchMemory(query, {
      maxResults: CONFIG.searchTopK * 2, // Get more than we need, filter after
      minScore: CONFIG.minRelevanceScore * 0.8 // Slightly relaxed for initial filter
    });
    
    console.log(`[adaptive-memory] Found ${results.length} results for: "${query.substring(0, 50)}..."`);
    
    return results;
  } catch (error) {
    console.error('[adaptive-memory] Search error:', error.message);
    return [];
  }
}

/**
 * Inject memory chunks into session context via daily memory file
 * 
 * Writes chunks to memory/YYYY-MM-DD.md under "Adaptive Memory Context (auto-injected)"
 * This allows the agent to naturally pick them up when reading daily memory.
 */
async function injectMemoryChunks(sessionKey, chunks) {
  if (!chunks || chunks.length === 0) {
    return 0;
  }

  try {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const homeDir = process.env.HOME || process.env.USERPROFILE;
    const memoryDir = path.join(homeDir, 'clawd', 'memory');
    const memoryPath = path.join(memoryDir, `${today}.md`);
    
    // Ensure memory directory exists
    if (!fs.existsSync(memoryDir)) {
      fs.mkdirSync(memoryDir, { recursive: true });
    }
    
    // Read existing memory file or create new one
    let existingContent = '';
    if (fs.existsSync(memoryPath)) {
      existingContent = fs.readFileSync(memoryPath, 'utf8');
    }
    
    // Build context injection section
    const timestamp = new Date().toISOString();
    const injectionSection = buildInjectionSection(chunks, timestamp);
    
    // Check if we already injected for this session (avoid duplicates)
    if (existingContent.includes('Adaptive Memory Context (auto-injected)')) {
      console.log(`[adaptive-memory] Context already injected for ${today}`);
      return chunks.length;
    }
    
    // Append injection section to memory file
    const newContent = existingContent.length > 0 
      ? existingContent + '\n\n' + injectionSection
      : injectionSection;
    
    fs.writeFileSync(memoryPath, newContent, 'utf8');
    
    console.log(`[adaptive-memory] Injected ${chunks.length} chunks into ${memoryPath}`);
    chunks.forEach((chunk, i) => {
      console.log(`  ${i+1}. ${path.basename(chunk.path)} (score: ${chunk.score.toFixed(2)})`);
    });
    
    return chunks.length;
    
  } catch (error) {
    console.error('[adaptive-memory] Injection error:', error.message);
    return 0;
  }
}

/**
 * Build the Adaptive Memory context injection section
 */
function buildInjectionSection(chunks, timestamp) {
  const lines = [
    '## Adaptive Memory Context (auto-injected)',
    `*Loaded at ${timestamp} by Adaptive Memory hook*`,
    '',
    'These chunks were automatically loaded based on your first message:',
    ''
  ];
  
  chunks.forEach((chunk, i) => {
    const sourceFile = path.basename(chunk.path);
    lines.push(`### ${i + 1}. ${sourceFile} (relevance: ${(chunk.score * 100).toFixed(0)}%)`);
    lines.push('');
    lines.push(chunk.snippet);
    lines.push('');
  });
  
  lines.push('---');
  
  return lines.join('\n');
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
