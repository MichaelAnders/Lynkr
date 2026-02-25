const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const THRESHOLD = 100;
const PREVIEW_EACH_SIDE = 48;
const HASH_LENGTH = 16;
const DEDUP_MAP_PATH = path.join(__dirname, 'dedup-map.json');

/**
 * LogDeduplicator — replaces repeated large strings in log objects with reference IDs
 *
 * Usage:
 *   const dedup = new LogDeduplicator();
 *   const cleanedObj = dedup.deduplicateObject({ tools: longString, msg: 'hello' });
 *   // -> { tools: { $ref: 'sha256:xxx', preview: '...', category: 'tools' }, msg: 'hello' }
 *   // -> on next identical string: { tools: { $ref: 'sha256:xxx' } }
 *
 * Storage:
 *   - In-memory Map for session-level fast lookup
 *   - Async JSON file writes to dedup-map.json (metadata only, no full content)
 *   - Concurrent writes are batched via _dirty flag + setImmediate
 */

class LogDeduplicator {
  constructor(options = {}) {
    this.mapPath = options.mapPath || DEDUP_MAP_PATH;
    this.threshold = options.threshold || THRESHOLD;
    this._sessionMap = new Map(); // hash -> { preview, category, firstSeen, lastSeen, count }
    this._dirty = false;
    this._writing = false;
    this._logger = null; // logger instance for emitting detail logs (injected later)
    this._currentLogLevel = 'info'; // will be set before deduplication
    this._loadMap();
  }

  /**
   * Load existing dedup map from file (sync, called once at startup)
   */
  _loadMap() {
    try {
      const raw = fs.readFileSync(this.mapPath, 'utf8');
      const parsed = JSON.parse(raw);
      for (const [hash, meta] of Object.entries(parsed)) {
        this._sessionMap.set(hash, meta);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        process.stderr.write(
          `[log-deduplicator] Failed to load ${this.mapPath}: ${err.message}\n`
        );
      }
      // Start empty if file doesn't exist or is invalid
    }
  }

  /**
   * Schedule an async write to the dedup map file (batches concurrent writes)
   */
  _scheduleWrite() {
    if (this._dirty) return;
    this._dirty = true;
    setImmediate(() => this._flushMap());
  }

  /**
   * Flush the in-memory map to disk (async, prevents overlapping writes)
   */
  async _flushMap() {
    if (this._writing) {
      this._dirty = true;
      setImmediate(() => this._flushMap());
      return;
    }

    this._writing = true;
    this._dirty = false;

    try {
      const obj = Object.fromEntries(this._sessionMap);
      const json = JSON.stringify(obj, null, 2);
      await fs.promises.writeFile(this.mapPath, json, 'utf8');
    } catch (err) {
      process.stderr.write(
        `[log-deduplicator] Failed to write ${this.mapPath}: ${err.message}\n`
      );
    } finally {
      this._writing = false;
      // If new entries arrived during write, schedule another flush
      if (this._dirty) {
        setImmediate(() => this._flushMap());
      }
    }
  }

  /**
   * Compute SHA-256 hash of content (first 16 hex chars)
   */
  _computeHash(str) {
    const hex = crypto.createHash('sha256').update(str, 'utf8').digest('hex');
    return `sha256:${hex.substring(0, HASH_LENGTH)}`;
  }

  /**
   * Build preview: smart preview with 100 char budget
   * For strings <= 100: show full
   * For strings > 100: show first 25% (max 100) + "..." + last 25% (max 100)
   */
  _buildPreview(str) {
    if (str.length <= 100) {
      return str;
    }
    // For > 100 chars: show first 25% and last 25%, each capped at 100
    const quarterLength = Math.min(Math.floor(str.length * 0.25), 100);
    return (
      str.substring(0, quarterLength) +
      '...' +
      str.substring(str.length - quarterLength)
    );
  }

  /**
   * Auto-detect category from key name (case-insensitive)
   */
  _detectCategory(keyName) {
    const k = (keyName || '').toLowerCase();

    if (k.includes('tool')) return 'tools';
    if (k.includes('system')) return 'system_message';
    if (k.includes('prompt')) return 'prompt';
    if (k.includes('stack')) return 'error_stack';
    if (k.includes('body') || k.includes('payload') || k.includes('request'))
      return 'request_body';
    if (k.includes('message') || k.includes('msg') || k.includes('content'))
      return 'message_content';

    return 'text';
  }

  /**
   * Process a single string: check if it should be deduplicated
   * Returns: string (unchanged if <= threshold) or { $ref, preview?, category? }
   */
  processString(str, keyName) {
    if (str.length <= this.threshold) {
      return str;
    }

    const hash = this._computeHash(str);

    if (this._sessionMap.has(hash)) {
      // Seen before: return compact reference only
      const meta = this._sessionMap.get(hash);
      meta.count += 1;
      meta.lastSeen = new Date().toISOString();
      this._scheduleWrite();
      return { $ref: hash };
    } else {
      // First occurrence: return reference + preview + category
      const preview = this._buildPreview(str);
      const category = this._detectCategory(keyName);
      const meta = {
        preview,
        category,
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        count: 1,
      };
      this._sessionMap.set(hash, meta);
      this._scheduleWrite();
      return { $ref: hash, preview, category };
    }
  }

  /**
   * Set logger instance for emitting detail logs
   */
  setLogger(logger, currentLevel = 'info') {
    this._logger = logger;
    this._currentLogLevel = currentLevel;
  }

  /**
   * Emit detail log for a deduplicated field
   */
  _emitDetailLog(fieldName, value) {
    if (!this._logger) return;
    try {
      this._logger[this._currentLogLevel](
        { value, field: fieldName },
        `detail.${fieldName}`
      );
    } catch (err) {
      // Silently fail if detail log can't be emitted
    }
  }

  /**
   * Check if a field name warrants a detail log entry
   */
  _shouldEmitDetailLog(keyName) {
    const k = (keyName || '').toLowerCase();
    return (
      k.includes('content') ||
      k.includes('usermessage') ||
      k.includes('user_message') ||
      k.includes('systemprompt') ||
      k.includes('system_prompt')
    );
  }

  /**
   * Recursively walk an object and deduplicate large strings
   */
  deduplicateObject(obj, _seen = new Set()) {
    if (obj === null || obj === undefined) {
      return obj;
    }

    if (typeof obj !== 'object') {
      return obj;
    }

    // Handle circular references
    if (_seen.has(obj)) {
      return '[Circular]';
    }
    _seen.add(obj);

    // Handle arrays
    if (Array.isArray(obj)) {
      return obj.map((item) => {
        if (typeof item === 'string' && item.length > this.threshold) {
          return this.processString(item, '');
        }
        if (item && typeof item === 'object') {
          return this.deduplicateObject(item, _seen);
        }
        return item;
      });
    }

    // Handle objects
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string' && value.length > this.threshold) {
        result[key] = this.processString(value, key);
        // Emit detail log for important fields like content, userMessage, systemPrompt
        if (this._shouldEmitDetailLog(key)) {
          this._emitDetailLog(key, value);
        }
      } else if (value && typeof value === 'object') {
        result[key] = this.deduplicateObject(value, _seen);
      } else {
        result[key] = value;
      }
    }
    return result;
  }
}

/**
 * Factory function
 */
function createLogDeduplicator(options = {}) {
  return new LogDeduplicator(options);
}

module.exports = { LogDeduplicator, createLogDeduplicator };
