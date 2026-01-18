#!/usr/bin/env node

/**
 * LLM Audit Log Parser
 *
 * Utility script to parse and query LLM audit logs.
 * Supports filtering by session, provider, correlation ID, and date range.
 *
 * Usage:
 *   node scripts/parse-audit-logs.js [options]
 *
 * Options:
 *   --session=<id>         Filter by session ID
 *   --correlation=<id>     Filter by correlation ID
 *   --provider=<name>      Filter by provider (ollama, databricks, etc.)
 *   --date=<YYYY-MM-DD>    Filter by date
 *   --from=<YYYY-MM-DD>    Filter from date (inclusive)
 *   --to=<YYYY-MM-DD>      Filter to date (inclusive)
 *   --type=<type>          Filter by type (llm_request, llm_response)
 *   --file=<path>          Path to audit log file (default: logs/llm-audit.log)
 *   --correlate            Group requests and responses by correlation ID
 *   --stats                Show statistics summary
 *   --json                 Output as JSON (default: pretty print)
 *
 * Examples:
 *   # View all logs for a session
 *   node scripts/parse-audit-logs.js --session=abc123
 *
 *   # View logs for a specific provider
 *   node scripts/parse-audit-logs.js --provider=ollama
 *
 *   # View logs for a date range
 *   node scripts/parse-audit-logs.js --from=2026-01-01 --to=2026-01-31
 *
 *   # Correlate requests with responses
 *   node scripts/parse-audit-logs.js --session=abc123 --correlate
 *
 *   # Show statistics
 *   node scripts/parse-audit-logs.js --stats
 */

const fs = require('fs');
const readline = require('readline');
const path = require('path');

// Parse command line arguments
function parseArgs() {
  const args = {
    session: null,
    correlation: null,
    provider: null,
    date: null,
    from: null,
    to: null,
    type: null,
    file: path.join(process.cwd(), 'logs', 'llm-audit.log'),
    correlate: false,
    stats: false,
    json: false,
  };

  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--')) {
      const [key, value] = arg.substring(2).split('=');
      if (key in args) {
        if (typeof args[key] === 'boolean') {
          args[key] = true;
        } else {
          args[key] = value;
        }
      }
    }
  }

  return args;
}

// Check if a log entry matches the filters
function matchesFilters(entry, filters) {
  if (filters.session && entry.sessionId !== filters.session) {
    return false;
  }

  if (filters.correlation && entry.correlationId !== filters.correlation) {
    return false;
  }

  if (filters.provider && entry.provider !== filters.provider) {
    return false;
  }

  if (filters.type && entry.type !== filters.type) {
    return false;
  }

  // Parse timestamp
  const entryDate = new Date(entry.timestamp || entry.time);

  if (filters.date) {
    const filterDate = new Date(filters.date);
    const entryDay = entryDate.toISOString().split('T')[0];
    const filterDay = filterDate.toISOString().split('T')[0];
    if (entryDay !== filterDay) {
      return false;
    }
  }

  if (filters.from) {
    const fromDate = new Date(filters.from);
    if (entryDate < fromDate) {
      return false;
    }
  }

  if (filters.to) {
    const toDate = new Date(filters.to);
    toDate.setHours(23, 59, 59, 999); // End of day
    if (entryDate > toDate) {
      return false;
    }
  }

  return true;
}

// Pretty print a log entry
function prettyPrint(entry) {
  const timestamp = entry.timestamp || entry.time;
  const type = entry.type || 'unknown';
  const provider = entry.provider || 'unknown';
  const model = entry.model || 'unknown';

  console.log('─'.repeat(80));
  console.log(`📅 ${timestamp}`);
  console.log(`🔗 Correlation ID: ${entry.correlationId || 'N/A'}`);
  console.log(`🔐 Session ID: ${entry.sessionId || 'N/A'}`);
  console.log(`📌 Type: ${type}`);
  console.log(`🏢 Provider: ${provider}`);
  console.log(`🤖 Model: ${model}`);
  console.log(`🌐 Destination: ${entry.destinationUrl || 'N/A'}`);

  if (entry.destinationIp) {
    console.log(`📍 IP: ${entry.destinationIp} (IPv${entry.destinationIpFamily || '?'})`);
  }

  if (type === 'llm_request') {
    console.log(`\n📤 Request Details:`);
    console.log(`   Stream: ${entry.stream ? 'Yes' : 'No'}`);
    console.log(`   Max Tokens: ${entry.maxTokens || 'N/A'}`);

    if (entry.userMessages) {
      console.log(`\n💬 User Messages:`);
      const messages = Array.isArray(entry.userMessages)
        ? entry.userMessages
        : [entry.userMessages];
      messages.forEach((msg, i) => {
        const content = typeof msg === 'string'
          ? msg
          : msg.content || JSON.stringify(msg);
        const preview = content.length > 200
          ? content.substring(0, 200) + '...'
          : content;
        console.log(`   [${i + 1}] ${preview}`);
      });
    }

    if (entry.tools && entry.tools.length > 0) {
      console.log(`\n🛠️  Tools: ${entry.tools.join(', ')}`);
    }

    if (entry.contentTruncated) {
      console.log(`\n⚠️  Content truncated (original length: ${entry.userMessagesOriginalLength || 'unknown'})`);
    }
  } else if (type === 'llm_response') {
    console.log(`\n📥 Response Details:`);
    console.log(`   Status: ${entry.status || 'N/A'}`);
    console.log(`   Latency: ${entry.latencyMs ? `${entry.latencyMs}ms` : 'N/A'}`);

    if (entry.usage) {
      console.log(`\n📊 Token Usage:`);
      console.log(`   Request: ${entry.usage.requestTokens || 0}`);
      console.log(`   Response: ${entry.usage.responseTokens || 0}`);
      console.log(`   Total: ${entry.usage.totalTokens || 0}`);
    }

    if (entry.assistantMessage) {
      console.log(`\n🤖 Assistant Message:`);
      const msg = entry.assistantMessage;
      const content = typeof msg === 'string'
        ? msg
        : msg.content || JSON.stringify(msg);
      const preview = content.length > 200
        ? content.substring(0, 200) + '...'
        : content;
      console.log(`   ${preview}`);
    }

    if (entry.streamingNote) {
      console.log(`\n📺 Streaming: ${entry.streamingNote}`);
    }

    if (entry.error) {
      console.log(`\n❌ Error: ${entry.error}`);
    }

    if (entry.contentTruncated) {
      console.log(`\n⚠️  Content truncated (original length: ${entry.assistantMessageOriginalLength || 'unknown'})`);
    }
  }

  console.log('');
}

// Calculate statistics
function calculateStats(entries) {
  const stats = {
    total: entries.length,
    requests: 0,
    responses: 0,
    providers: {},
    models: {},
    errors: 0,
    streaming: 0,
    totalLatency: 0,
    totalRequestTokens: 0,
    totalResponseTokens: 0,
  };

  for (const entry of entries) {
    if (entry.type === 'llm_request') {
      stats.requests++;
      if (entry.stream) {
        stats.streaming++;
      }
    } else if (entry.type === 'llm_response') {
      stats.responses++;
      if (entry.error) {
        stats.errors++;
      }
      if (entry.latencyMs) {
        stats.totalLatency += entry.latencyMs;
      }
      if (entry.usage) {
        stats.totalRequestTokens += entry.usage.requestTokens || 0;
        stats.totalResponseTokens += entry.usage.responseTokens || 0;
      }
    }

    // Count providers
    if (entry.provider) {
      stats.providers[entry.provider] = (stats.providers[entry.provider] || 0) + 1;
    }

    // Count models
    if (entry.model) {
      stats.models[entry.model] = (stats.models[entry.model] || 0) + 1;
    }
  }

  return stats;
}

// Print statistics
function printStats(stats) {
  console.log('═'.repeat(80));
  console.log('📊 AUDIT LOG STATISTICS');
  console.log('═'.repeat(80));
  console.log(`\n📈 Overview:`);
  console.log(`   Total Entries: ${stats.total}`);
  console.log(`   Requests: ${stats.requests}`);
  console.log(`   Responses: ${stats.responses}`);
  console.log(`   Errors: ${stats.errors}`);
  console.log(`   Streaming: ${stats.streaming}`);

  if (stats.responses > 0) {
    const avgLatency = stats.totalLatency / stats.responses;
    console.log(`\n⏱️  Latency:`);
    console.log(`   Average: ${avgLatency.toFixed(2)}ms`);
    console.log(`   Total: ${stats.totalLatency}ms`);
  }

  if (stats.totalRequestTokens > 0 || stats.totalResponseTokens > 0) {
    console.log(`\n🪙  Token Usage:`);
    console.log(`   Request Tokens: ${stats.totalRequestTokens.toLocaleString()}`);
    console.log(`   Response Tokens: ${stats.totalResponseTokens.toLocaleString()}`);
    console.log(`   Total Tokens: ${(stats.totalRequestTokens + stats.totalResponseTokens).toLocaleString()}`);
  }

  if (Object.keys(stats.providers).length > 0) {
    console.log(`\n🏢 Providers:`);
    for (const [provider, count] of Object.entries(stats.providers).sort((a, b) => b[1] - a[1])) {
      console.log(`   ${provider}: ${count}`);
    }
  }

  if (Object.keys(stats.models).length > 0) {
    console.log(`\n🤖 Models:`);
    for (const [model, count] of Object.entries(stats.models).sort((a, b) => b[1] - a[1])) {
      console.log(`   ${model}: ${count}`);
    }
  }

  console.log('');
}

// Correlate requests with responses
function correlateEntries(entries) {
  const correlated = new Map();

  for (const entry of entries) {
    const corrId = entry.correlationId;
    if (!corrId) continue;

    if (!correlated.has(corrId)) {
      correlated.set(corrId, { request: null, response: null });
    }

    const pair = correlated.get(corrId);
    if (entry.type === 'llm_request') {
      pair.request = entry;
    } else if (entry.type === 'llm_response') {
      pair.response = entry;
    }
  }

  return Array.from(correlated.values());
}

// Print correlated entries
function printCorrelated(pairs) {
  for (const pair of pairs) {
    console.log('═'.repeat(80));
    if (pair.request) {
      console.log('📤 REQUEST');
      prettyPrint(pair.request);
    }
    if (pair.response) {
      console.log('📥 RESPONSE');
      prettyPrint(pair.response);
    }
    if (!pair.request || !pair.response) {
      console.log('⚠️  Missing ' + (!pair.request ? 'request' : 'response'));
    }
  }
}

// Main function
async function main() {
  const args = parseArgs();

  // Check if log file exists
  if (!fs.existsSync(args.file)) {
    console.error(`❌ Log file not found: ${args.file}`);
    process.exit(1);
  }

  const entries = [];

  // Read log file line by line
  const fileStream = fs.createReadStream(args.file);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;

    try {
      const entry = JSON.parse(line);
      if (matchesFilters(entry, args)) {
        entries.push(entry);
      }
    } catch (err) {
      // Skip invalid JSON lines
      continue;
    }
  }

  if (entries.length === 0) {
    console.log('No matching entries found.');
    return;
  }

  // Output results
  if (args.json) {
    console.log(JSON.stringify(entries, null, 2));
  } else if (args.stats) {
    const stats = calculateStats(entries);
    printStats(stats);
  } else if (args.correlate) {
    const pairs = correlateEntries(entries);
    printCorrelated(pairs);
  } else {
    for (const entry of entries) {
      prettyPrint(entry);
    }
  }

  console.log(`\n✅ Found ${entries.length} matching entries`);
}

// Run
main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
