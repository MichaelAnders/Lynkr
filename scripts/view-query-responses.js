#!/usr/bin/env node

/**
 * View Query-Response Pairs from LLM Audit Log
 *
 * Extracts and displays llm_query_response_pair entries from the audit log
 * with full query and response content (no truncation).
 *
 * Usage:
 *   node scripts/view-query-responses.js [--search=term] [--limit=10] [--json]
 */

const fs = require('fs');
const path = require('path');

// Parse command line args
const args = process.argv.slice(2);
const searchTerm = args.find(arg => arg.startsWith('--search='))?.split('=')[1];
const limit = parseInt(args.find(arg => arg.startsWith('--limit='))?.split('=')[1] || '0');
const jsonOutput = args.includes('--json');

// Read audit log
const logFile = path.join(__dirname, '../logs/llm-audit.log');

if (!fs.existsSync(logFile)) {
  console.error('No audit log found at:', logFile);
  process.exit(1);
}

const logContent = fs.readFileSync(logFile, 'utf-8');
const lines = logContent.trim().split('\n').filter(l => l);

// Parse and filter entries
const queryResponsePairs = [];

for (const line of lines) {
  try {
    const entry = JSON.parse(line);

    if (entry.type === 'llm_query_response_pair') {
      // Apply search filter if provided
      if (searchTerm) {
        const queryStr = JSON.stringify(entry.userQuery || '').toLowerCase();
        const responseStr = JSON.stringify(entry.assistantResponse || '').toLowerCase();
        const search = searchTerm.toLowerCase();

        if (!queryStr.includes(search) && !responseStr.includes(search)) {
          continue;
        }
      }

      queryResponsePairs.push(entry);
    }
  } catch (err) {
    // Skip malformed lines
  }
}

// Apply limit
const results = limit > 0 ? queryResponsePairs.slice(-limit) : queryResponsePairs;

// Output results
if (jsonOutput) {
  console.log(JSON.stringify(results, null, 2));
} else {
  if (results.length === 0) {
    console.log('No query-response pairs found' + (searchTerm ? ` matching "${searchTerm}"` : ''));
    process.exit(0);
  }

  console.log(`\nFound ${results.length} query-response pair(s)\n`);
  console.log('='.repeat(80));

  results.forEach((entry, idx) => {
    console.log(`\n[${idx + 1}] ${entry.requestTime} (${entry.latencyMs}ms)`);
    console.log(`Provider: ${entry.provider} | Model: ${entry.model}`);
    console.log(`Correlation ID: ${entry.correlationId}`);

    if (entry.usage) {
      console.log(`Tokens: ${entry.usage.requestTokens} in / ${entry.usage.responseTokens} out / ${entry.usage.totalTokens} total`);
    }

    console.log('\n--- USER QUERY ---');

    // Handle different query formats
    if (typeof entry.userQuery === 'string') {
      console.log(entry.userQuery);
    } else if (Array.isArray(entry.userQuery)) {
      entry.userQuery.forEach(msg => {
        if (msg.type === 'text') {
          console.log(msg.text);
        } else {
          console.log(JSON.stringify(msg, null, 2));
        }
      });
    } else {
      console.log(JSON.stringify(entry.userQuery, null, 2));
    }

    console.log('\n--- ASSISTANT RESPONSE ---');

    // Handle different response formats
    if (typeof entry.assistantResponse === 'string') {
      console.log(entry.assistantResponse);
    } else if (entry.assistantResponse?.content) {
      // OpenAI format
      console.log(entry.assistantResponse.content);
    } else if (Array.isArray(entry.assistantResponse)) {
      // Anthropic format
      entry.assistantResponse.forEach(block => {
        if (block.type === 'text') {
          console.log(block.text);
        } else if (block.type === 'tool_use') {
          console.log(`[Tool: ${block.name}]`);
          console.log(JSON.stringify(block.input, null, 2));
        } else {
          console.log(JSON.stringify(block, null, 2));
        }
      });
    } else {
      console.log(JSON.stringify(entry.assistantResponse, null, 2));
    }

    console.log('\n' + '='.repeat(80));
  });

  console.log(`\n${results.length} pair(s) displayed\n`);
}
