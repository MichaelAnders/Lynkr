# Fix Load Shedding Race Condition & Memory Leaks

## Problem Summary

You're experiencing:
- "service temporarily overloaded" messages with 87% heap usage (threshold: 90%)
- `activeRequests: 0` but `totalShed: 51` - requests being rejected incorrectly
- High heap usage persists even when no requests are active
- Increasing heap threshold doesn't help

**Root Cause**: Race condition in activeRequests tracking + 7 memory leaks preventing garbage collection.

## Critical Issues Found

### 1. RACE CONDITION (CRITICAL) - Explains Your Exact Symptoms
**File**: `src/api/middleware/load-shedding.js:156-164`

Both `finish` and `close` events decrement `activeRequests`:
```javascript
res.on("finish", () => {
  shedder.activeRequests--;  // Event 1
});

res.on("close", () => {
  if (shedder.activeRequests > 0) {
    shedder.activeRequests--;  // Event 2 - can still fire!
  }
});
```

**Problem**: Both events can fire for the same request, causing:
- Counter becomes inaccurate (can go negative or miss decrements)
- Load shedding triggers incorrectly when `activeRequests` is wrong
- Explains why you see `activeRequests: 0` but still getting shed

### 2. STREAM MEMORY LEAK (HIGH IMPACT)
**File**: `src/api/router.js:136-180`

ReadableStream readers never call `releaseLock()` or `cancel()`:
```javascript
const reader = result.stream.getReader();  // Line 139
try {
  while (true) {
    const { done, value } = await reader.read();
    // ... processing
  }
} catch (streamError) {
  // NO cleanup - reader stays locked!
}
// NO finally block with releaseLock()
```

**Impact**: Each streaming request leaves resources locked in memory indefinitely.

### 3. PROMPT CACHE GROWS UNBOUNDED (HIGH IMPACT)
**File**: `src/cache/prompt.js`

- Holds up to 1000 cache entries (line 39)
- `pruneExpired()` only called on init and write operations
- If writes stop, expired entries accumulate forever
- No timer-based cleanup

### 4-7. OTHER MEMORY LEAKS (MEDIUM-LOW IMPACT)
- **Session history**: No automatic cleanup, grows unbounded
- **Metrics arrays**: Grow to 10k entries and stay there
- **HTTP keep-alive**: Sockets hold memory (managed by Node.js but can be optimized)
- **Incomplete shutdown**: Missing cleanup for caches, sessions, agents

## Implementation Plan

### Priority 1: Fix Race Condition (IMMEDIATE)
**File**: `src/api/middleware/load-shedding.js:152-166`

Replace lines 152-166 with:
```javascript
// Track active request
shedder.activeRequests++;

// Use flag to prevent double-decrement race condition
let decremented = false;
const decrementOnce = () => {
  if (!decremented) {
    decremented = true;
    shedder.activeRequests--;
  }
};

// Both events might fire, but only decrement once
res.on("finish", decrementOnce);
res.on("close", decrementOnce);
```

**Why this works**: The closure captures `decremented` flag per-request, preventing both events from decrementing.

### Priority 2: Fix Stream Cleanup (IMMEDIATE)
**File**: `src/api/router.js:136-180`

Wrap stream processing in try-finally:
```javascript
const reader = result.stream.getReader();
const decoder = new TextDecoder();
let buffer = '';

try {
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.trim()) {
        res.write(line + '\n');
      }
    }

    if (typeof res.flush === 'function') {
      res.flush();
    }
  }

  // Send remaining buffer
  if (buffer.trim()) {
    res.write(buffer + '\n');
  }

  metrics.recordResponse(200);
  res.end();
  return;
} catch (streamError) {
  logger.error({ error: streamError }, "Error streaming response");

  // Cancel stream on error
  try {
    await reader.cancel();
  } catch (cancelError) {
    logger.debug({ error: cancelError }, "Failed to cancel stream");
  }

  if (!res.headersSent) {
    res.status(500).json({ error: "Streaming error" });
  } else {
    res.end();
  }
  return;
} finally {
  // CRITICAL: Always release lock
  try {
    reader.releaseLock();
  } catch (releaseError) {
    // Lock may already be released, ignore
    logger.debug({ error: releaseError }, "Stream lock already released");
  }
}
```

### Priority 3: Add Prompt Cache Pruning (HIGH)
**File**: `src/cache/prompt.js`

Add timer-based pruning to constructor (after line 46):
```javascript
constructor(options = {}) {
  this.enabled = options.enabled === true;
  this.maxEntries = /* ... existing code ... */;
  this.ttlMs = /* ... existing code ... */;

  // Add pruning interval (default: 5 minutes)
  this.pruneIntervalMs = options.pruneIntervalMs || 300000;

  if (this.enabled) {
    this.initDatabase();
    this.startPruning();  // NEW: Start background pruning
  }
}

startPruning() {
  if (this.pruneTimer) return;

  this.pruneTimer = setInterval(() => {
    try {
      this.pruneExpired();
      logger.debug("Prompt cache pruning completed");
    } catch (error) {
      logger.warn({ error }, "Failed to prune cache in background");
    }
  }, this.pruneIntervalMs);

  // Don't prevent process exit
  this.pruneTimer.unref();

  logger.info({ intervalMs: this.pruneIntervalMs }, "Prompt cache pruning started");
}

stopPruning() {
  if (this.pruneTimer) {
    clearInterval(this.pruneTimer);
    this.pruneTimer = null;
    logger.debug("Prompt cache pruning stopped");
  }
}

close() {
  this.stopPruning();  // NEW: Stop pruning first
  if (this.db) {
    try {
      this.pruneExpired();  // Final cleanup
      this.db.close();
    } catch (error) {
      logger.warn({ error }, "Failed to close cache database");
    }
  }
}
```

Update exports at end of file to include:
```javascript
module.exports.close = function() {
  promptCache.close();
};
```

### Priority 4: Add Session Cleanup (MEDIUM)
**File**: `src/sessions/store.js`

Add cleanup prepared statements after existing statements:
```javascript
const CLEANUP_OLD_SESSIONS_STMT = db.prepare(`
  DELETE FROM sessions
  WHERE updated_at < ?
`);

const CLEANUP_OLD_HISTORY_STMT = db.prepare(`
  DELETE FROM session_history
  WHERE timestamp < ?
`);

function cleanupOldSessions(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  const cutoffTime = Date.now() - maxAgeMs;
  const result = CLEANUP_OLD_SESSIONS_STMT.run(cutoffTime);
  logger.info({ deleted: result.changes, maxAgeMs }, "Cleaned up old sessions");
  return result.changes;
}

function cleanupOldHistory(maxAgeMs = 30 * 24 * 60 * 60 * 1000) {
  const cutoffTime = Date.now() - maxAgeMs;
  const result = CLEANUP_OLD_HISTORY_STMT.run(cutoffTime);
  logger.info({ deleted: result.changes, maxAgeMs }, "Cleaned up old history");
  return result.changes;
}

// Add to exports
module.exports = {
  // ... existing exports ...
  cleanupOldSessions,
  cleanupOldHistory,
};
```

**Create**: `src/sessions/cleanup.js` (new file) - Background cleanup manager:
```javascript
const logger = require("../logger");
const { cleanupOldSessions, cleanupOldHistory } = require("./store");

class SessionCleanupManager {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.intervalMs = options.intervalMs || 3600000; // 1 hour
    this.sessionMaxAgeMs = options.sessionMaxAgeMs || 7 * 24 * 60 * 60 * 1000; // 7 days
    this.historyMaxAgeMs = options.historyMaxAgeMs || 30 * 24 * 60 * 60 * 1000; // 30 days
    this.timer = null;
  }

  start() {
    if (!this.enabled || this.timer) return;

    this.runCleanup(); // Run immediately

    this.timer = setInterval(() => this.runCleanup(), this.intervalMs);
    this.timer.unref();

    logger.info({
      intervalMs: this.intervalMs,
      sessionMaxAgeMs: this.sessionMaxAgeMs
    }, "Session cleanup started");
  }

  runCleanup() {
    try {
      const sessionsDeleted = cleanupOldSessions(this.sessionMaxAgeMs);
      const historyDeleted = cleanupOldHistory(this.historyMaxAgeMs);
      logger.info({ sessionsDeleted, historyDeleted }, "Session cleanup completed");
    } catch (error) {
      logger.error({ error }, "Session cleanup failed");
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info("Session cleanup stopped");
    }
  }
}

let instance = null;

function getSessionCleanupManager(options) {
  if (!instance) instance = new SessionCleanupManager(options);
  return instance;
}

module.exports = { SessionCleanupManager, getSessionCleanupManager };
```

**Integrate in**: `src/server.js` (in start function):
```javascript
const { getSessionCleanupManager } = require("./sessions/cleanup");

// After server starts
const sessionCleanup = getSessionCleanupManager();
sessionCleanup.start();
```

### Priority 5: Fix Metrics Arrays (MEDIUM)
**File**: `src/observability/metrics.js`

Change from unbounded arrays to circular buffers:
```javascript
// Update maxLatencyBuffer (reduce from 10000 to 1000)
this.maxLatencyBuffer = 1000;

// Add helper method
addToBuffer(buffer, value, maxSize) {
  buffer.push(value);
  if (buffer.length > maxSize) {
    buffer.shift(); // Remove oldest
  }
}

// Update recordRequest, recordProviderSuccess, recordFallbackSuccess
// Replace buffer.push(value) with:
this.addToBuffer(this.requestLatencies, durationMs, this.maxLatencyBuffer);
this.addToBuffer(this.ollamaLatencies, latencyMs, this.maxLatencyBuffer);
this.addToBuffer(this.fallbackLatencies, latencyMs, this.maxLatencyBuffer);
```

### Priority 6: Comprehensive Shutdown (MEDIUM)
**File**: `src/server/shutdown.js`

Update shutdown sequence (around line 110):
```javascript
// After closing server and connections...

// Step 3: Stop background tasks
logger.info("Step 3: Stopping background tasks");
try {
  const { getSessionCleanupManager } = require("../sessions/cleanup");
  const sessionCleanup = getSessionCleanupManager();
  if (sessionCleanup) sessionCleanup.stop();
} catch (err) {
  logger.warn({ err }, "Error stopping session cleanup");
}

// Step 4: Close cache databases
logger.info("Step 4: Closing cache databases");
try {
  const promptCache = require("../cache/prompt");
  if (promptCache && promptCache.close) promptCache.close();
} catch (err) {
  logger.warn({ err }, "Error closing prompt cache");
}

// Step 5: Close database connections (existing budget manager code)
logger.info("Step 5: Closing database connections");
// ... existing code ...

// Step 6: Destroy HTTP agents
logger.info("Step 6: Destroying HTTP agents");
try {
  const { destroyHttpAgents } = require("../clients/databricks");
  if (destroyHttpAgents) destroyHttpAgents();
} catch (err) {
  logger.warn({ err }, "Error destroying HTTP agents");
}
```

### Priority 7: HTTP Agent Cleanup (LOW)
**File**: `src/clients/databricks.js`

Add cleanup function (optional, but good practice):
```javascript
function destroyHttpAgents() {
  try {
    if (httpAgent) httpAgent.destroy();
    if (httpsAgent) httpsAgent.destroy();
    logger.info("HTTP agents destroyed");
  } catch (error) {
    logger.warn({ error }, "Failed to destroy HTTP agents");
  }
}

module.exports = {
  invokeModel,
  destroyHttpAgents,
};
```

## Configuration Changes

**File**: `src/config/index.js` (or environment variables)

Add:
```javascript
promptCache: {
  enabled: parseBool(process.env.PROMPT_CACHE_ENABLED, true),
  maxEntries: parseInt(process.env.PROMPT_CACHE_MAX_ENTRIES) || 1000,
  ttlMs: parseInt(process.env.PROMPT_CACHE_TTL_MS) || 300000,
  pruneIntervalMs: parseInt(process.env.PROMPT_CACHE_PRUNE_INTERVAL_MS) || 300000,
},

sessionCleanup: {
  enabled: parseBool(process.env.SESSION_CLEANUP_ENABLED, true),
  intervalMs: parseInt(process.env.SESSION_CLEANUP_INTERVAL_MS) || 3600000,
  sessionMaxAgeMs: parseInt(process.env.SESSION_MAX_AGE_MS) || 604800000,
  historyMaxAgeMs: parseInt(process.env.HISTORY_MAX_AGE_MS) || 2592000000,
},

metrics: {
  maxLatencyBuffer: parseInt(process.env.METRICS_MAX_LATENCY_BUFFER) || 1000,
},
```

**Environment variables** (optional, defaults shown above):
```bash
PROMPT_CACHE_PRUNE_INTERVAL_MS=300000      # 5 minutes
SESSION_CLEANUP_ENABLED=true
SESSION_CLEANUP_INTERVAL_MS=3600000        # 1 hour
SESSION_MAX_AGE_MS=604800000               # 7 days
METRICS_MAX_LATENCY_BUFFER=1000
```

## Critical Files

- `src/api/middleware/load-shedding.js` - Race condition fix (MUST FIX FIRST)
- `src/api/router.js` - Stream cleanup
- `src/cache/prompt.js` - Timer-based pruning
- `src/sessions/store.js` - Cleanup functions
- `src/sessions/cleanup.js` - NEW FILE - Background cleanup manager
- `src/observability/metrics.js` - Circular buffers
- `src/server/shutdown.js` - Comprehensive shutdown
- `src/clients/databricks.js` - Agent cleanup (optional)
- `src/server.js` - Start session cleanup manager

## Verification Plan

### Step 1: Verify Race Condition Fix
```bash
# Start server
node src/server.js

# Load test in another terminal
ab -n 10000 -c 100 http://localhost:8080/v1/messages

# Check metrics endpoint
curl http://localhost:8080/metrics/load-shedding | jq

# Expected:
# - activeRequests returns to 0 when load test completes
# - Counter never goes negative
# - heapUsedPercent drops significantly
```

### Step 2: Monitor Heap Usage
```bash
# Watch metrics continuously
watch -n 5 'curl -s http://localhost:8080/metrics/load-shedding | jq'

# Expected:
# - Heap usage stabilizes after initial requests
# - Heap drops when activeRequests = 0
# - No continuous growth over time
```

### Step 3: Test Stream Cleanup
```bash
# Make streaming requests
curl -N http://localhost:8080/v1/messages -d '{"stream": true, ...}'

# Monitor heap before and after
curl http://localhost:8080/metrics/observability | jq '.memory_usage.heapUsed'

# Expected:
# - Heap releases after stream completes
# - No accumulation over multiple streaming requests
```

### Step 4: Verify Cache Pruning
```bash
# Check logs for pruning activity (every 5 minutes)
tail -f logs/app.log | grep "cache pruning"

# Query cache size
sqlite3 data/prompt-cache.db "SELECT COUNT(*) FROM prompt_cache;"

# Expected:
# - Pruning runs every 5 minutes
# - Cache size stays under 1000 entries
# - Expired entries are removed
```

### Step 5: Load Test Verification
Run extended load test and monitor heap:
```bash
# Terminal 1: Server with GC exposed
node --expose-gc src/server.js

# Terminal 2: Monitor heap every 10 seconds
while true; do
  curl -s http://localhost:8080/metrics/observability | jq '.memory_usage.heapUsed'
  sleep 10
done

# Terminal 3: Sustained load
ab -n 50000 -c 50 -t 300 http://localhost:8080/v1/messages
```

**Success criteria**:
- Heap usage stabilizes (< 20% variance after warmup)
- `activeRequests` accurately returns to 0 when idle
- No "service temporarily overloaded" false positives
- `totalShed` only increments during actual overload
- Heap usage correlates with actual load, not phantom growth

## Expected Outcome

**Before fixes**:
- ❌ `activeRequests: 0` but heap at 87%
- ❌ False positive load shedding (`totalShed: 51`)
- ❌ Heap never drops even when idle
- ❌ Memory accumulates over time

**After fixes**:
- ✅ `activeRequests` accurately tracks concurrent requests
- ✅ Load shedding only triggers during actual overload
- ✅ Heap drops significantly when requests complete
- ✅ Memory stabilizes at reasonable baseline
- ✅ No phantom memory growth

## Implementation Order

1. **Day 1**: Fix race condition (Priority 1) - Test immediately
2. **Day 1**: Fix stream cleanup (Priority 2) - Test with streaming requests
3. **Day 2**: Add cache pruning (Priority 3) - Monitor for 24h
4. **Day 3**: Add session cleanup (Priority 4) - Background task
5. **Day 3**: Fix metrics arrays (Priority 5)
6. **Day 4**: Update shutdown (Priority 6)
7. **Day 4**: Add HTTP cleanup (Priority 7) - Optional
8. **Day 5**: Integration testing and monitoring

## Rollback Plan

If issues occur:
1. Disable background tasks via config:
   ```bash
   PROMPT_CACHE_PRUNE_INTERVAL_MS=0
   SESSION_CLEANUP_ENABLED=false
   ```
2. Revert specific file changes
3. Database changes are backward compatible (no migrations needed)

## Notes

- Race condition fix is **critical** - explains your exact symptoms
- Stream cleanup has **high impact** - major memory leak
- All other fixes are **cumulative improvements** - each reduces memory pressure
- Increasing heap threshold won't help - need to fix leaks at the source
- These fixes work together: race condition + leaks = compound problem
