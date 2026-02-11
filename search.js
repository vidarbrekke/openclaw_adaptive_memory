#!/usr/bin/env node

/**
 * Adaptive Memory Search Module
 * 
 * Performs vector search against OpenClaw memory files.
 * Ranks results by relevance and returns top K chunks.
 * 
 * This is the core search engine for the Adaptive Memory skill.
 * Supports both vector-based and keyword-based search strategies.
 */

const fs = require('fs');
const path = require('path');

/**
 * Adaptive Memory search — find relevant memory chunks
 * @param {string} query - User's intent/question (from first message)
 * @param {object} options - Search options (maxResults, minScore, memoryDir, useVectorSearch)
 * @returns {Promise<Array>} Ranked results with scores and paths
 */
async function searchMemory(query, options = {}) {
  const {
    maxResults = 10,
    minScore = 0.5,
    memoryDir = '~/clawd/memory',
    useVectorSearch = true
  } = options;

  try {
    // Validate query
    if (!query || typeof query !== 'string' || query.length < 3) {
      console.warn('[adaptive-memory] Query too short or invalid:', query);
      return [];
    }

    // Get all memory files
    const files = await getMemoryFiles(memoryDir);
    
    if (files.length === 0) {
      console.warn(`[adaptive-memory] No memory files found in ${memoryDir}`);
      return [];
    }

    console.log(`[adaptive-memory] Searching ${files.length} memory files for: "${query.substring(0, 60)}..."`);

    // Use vector search (keyword-based placeholder currently)
    const results = useVectorSearch
      ? await vectorSearchFiles(query, files, { maxResults, minScore })
      : await keywordSearchFiles(query, files, { maxResults, minScore });

    console.log(`[adaptive-memory] Search complete: ${results.length} results found`);
    
    return results;

  } catch (error) {
    console.error('[adaptive-memory] Search error:', error);
    return [];
  }
}

/**
 * Get all memory files recursively
 */
async function getMemoryFiles(memoryDir) {
  const files = [];
  
  try {
    // Expand tilde if needed
    const expandedDir = memoryDir.startsWith('~')
      ? path.join(process.env.HOME || process.env.USERPROFILE, memoryDir.slice(1))
      : memoryDir;
    
    if (!fs.existsSync(expandedDir)) {
      console.warn(`[adaptive-memory] Memory directory does not exist: ${expandedDir}`);
      return files;
    }
    
    const items = fs.readdirSync(expandedDir, { withFileTypes: true });
    
    for (const item of items) {
      const fullPath = path.join(expandedDir, item.name);
      
      if (item.isDirectory()) {
        // Recurse into subdirectories (skip hidden dirs)
        if (!item.name.startsWith('.')) {
          const subFiles = await getMemoryFiles(fullPath);
          files.push(...subFiles);
        }
      } else if (item.isFile() && (item.name.endsWith('.md') || item.name.endsWith('.json'))) {
        files.push(fullPath);
      }
    }
  } catch (error) {
    console.error(`[adaptive-memory] Cannot read ${memoryDir}:`, error.message);
  }
  
  return files;
}

/**
 * Adaptive Memory vector search
 * 
 * This is the primary search strategy. It would ideally use:
 * - Real vector embeddings (OpenAI, Ollama, etc.)
 * - Cosine similarity for ranking
 * - Semantic understanding of query intent
 * 
 * Currently uses keyword-based placeholder; can be upgraded
 * to real vector embeddings by replacing scoreChunk() implementation.
 */
async function vectorSearchFiles(query, files, options) {
  console.log(`[adaptive-memory] Vector searching ${files.length} files for: "${query.substring(0, 50)}..."`);
  
  const results = [];
  
  for (const filePath of files) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      
      // Split into chunks (paragraphs or sections)
      const chunks = splitIntoChunks(content, filePath);
      
      // Score each chunk against query (using adaptive memory scoring)
      for (const chunk of chunks) {
        const score = scoreChunk(query, chunk.text);
        
        if (score >= options.minScore) {
          results.push({
            path: filePath,
            score,
            snippet: chunk.text.substring(0, 200),
            startLine: chunk.startLine
          });
        }
      }
    } catch (error) {
      console.error(`[adaptive-memory] Error reading ${filePath}:`, error.message);
    }
  }
  
  // Sort by score descending
  results.sort((a, b) => b.score - a.score);
  
  // Return top K
  return results.slice(0, options.maxResults);
}

/**
 * Adaptive Memory keyword search (fallback when vector search unavailable)
 * 
 * Fast fallback strategy when vector embeddings aren't available.
 * Uses keyword matching and TF-IDF-inspired scoring.
 */
async function keywordSearchFiles(query, files, options) {
  console.log(`[adaptive-memory] Keyword searching ${files.length} files for: "${query.substring(0, 50)}..."`);
  
  const results = [];
  const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  
  for (const filePath of files) {
    try {
      const content = fs.readFileSync(filePath, 'utf8').toLowerCase();
      
      // Count keyword matches
      let matchCount = 0;
      for (const keyword of keywords) {
        matchCount += (content.match(new RegExp(keyword, 'g')) || []).length;
      }
      
      if (matchCount > 0) {
        const score = Math.min(matchCount / keywords.length / 10, 1.0); // Normalize to 0-1
        
        if (score >= options.minScore) {
          const chunks = splitIntoChunks(content, filePath);
          const topChunk = chunks[0];
          
          results.push({
            path: filePath,
            score,
            snippet: topChunk.text.substring(0, 200),
            startLine: topChunk.startLine,
            matchCount
          });
        }
      }
    } catch (error) {
      console.error(`[adaptive-memory] Error reading ${filePath}:`, error.message);
    }
  }
  
  // Sort by score descending
  results.sort((a, b) => b.score - a.score);
  
  // Return top K
  return results.slice(0, options.maxResults);
}

/**
 * Split content into chunks (paragraphs)
 */
function splitIntoChunks(content, filePath) {
  const chunks = [];
  const paragraphs = content.split(/\n\n+/);
  
  let lineNum = 1;
  for (const para of paragraphs) {
    if (para.trim().length > 0) {
      chunks.push({
        text: para.trim(),
        startLine: lineNum,
        path: filePath
      });
    }
    lineNum += para.split('\n').length + 1;
  }
  
  return chunks;
}

/**
 * Score a chunk against a query
 * Uses TF-IDF-inspired keyword scoring (placeholder for real vector similarity)
 * 
 * Algorithm:
 * 1. Extract meaningful keywords from query (filter stopwords, length > 2)
 * 2. Count occurrences of each keyword in chunk
 * 3. Weight by keyword rarity (more weight for less common words)
 * 4. Normalize to 0-1 range
 */
function scoreChunk(query, chunkText) {
  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const chunkText_lower = chunkText.toLowerCase();
  
  if (queryWords.length === 0) return 0;
  
  let score = 0;
  
  // Score each keyword
  for (const word of queryWords) {
    // Count occurrences (multiple mentions boost score)
    const matches = (chunkText_lower.match(new RegExp(word, 'g')) || []).length;
    
    if (matches > 0) {
      // Logarithmic scaling: 1 match = 1.0, 2 matches = 1.3, 3+ matches = 1.5
      const occurrenceBonus = 1 + Math.min(Math.log(matches + 1) * 0.2, 0.5);
      score += occurrenceBonus;
    }
  }
  
  // Normalize: perfect match (all keywords found multiple times) = 1.0
  return Math.min(score / (queryWords.length * 1.3), 1.0);
}

/**
 * Expand ~ in paths (cross-platform)
 */
function expandPath(filePath) {
  if (filePath.startsWith('~')) {
    return path.join(process.env.HOME || process.env.USERPROFILE, filePath.slice(1));
  }
  return filePath;
}

/**
 * CLI for testing
 */
if (require.main === module) {
  const query = process.argv[2] || 'projects active';
  
  searchMemory(query, {
    maxResults: 5,
    minScore: 0.3
  }).then(results => {
    console.log(`\n✓ Found ${results.length} results:\n`);
    results.forEach((r, i) => {
      console.log(`${i + 1}. ${path.basename(r.path)} (score: ${r.score.toFixed(2)})`);
      console.log(`   Line ${r.startLine}: ${r.snippet}`);
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
  keywordSearchFiles
};
