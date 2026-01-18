const pino = require("pino");
const path = require("path");
const fs = require("fs");

/**
 * LLM Audit Logger
 *
 * Dedicated logger for capturing LLM request/response audit trails.
 * Logs to a separate file for easy parsing, searching, and compliance.
 *
 * Log Entry Types:
 * - llm_request: User messages sent to LLM providers
 * - llm_response: LLM responses received from providers
 *
 * Key Features:
 * - Separate log file (llm-audit.log) for easy parsing
 * - Correlation IDs to link requests with responses
 * - Network destination tracking (IP, hostname, URL)
 * - Content truncation to control log size
 * - Async writes for minimal latency impact
 * - Daily log rotation with configurable retention
 */

/**
 * Create audit logger instance
 * @param {Object} config - Audit configuration
 * @returns {Object} Pino logger instance
 */
function createAuditLogger(config) {
  // Ensure log directory exists
  const logDir = path.dirname(config.logFile);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  // Create dedicated pino instance for audit logs
  const auditLogger = pino(
    {
      level: "info", // Always log at info level for compliance
      name: "llm-audit",
      base: null, // Don't include pid/hostname to keep logs clean
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label) => {
          return { level: label };
        },
      },
    },
    pino.destination({
      dest: config.logFile,
      sync: false, // Async writes for performance
      mkdir: true,
    })
  );

  return auditLogger;
}

/**
 * Truncate content if it exceeds max length
 * @param {string|Array|Object} content - Content to truncate
 * @param {number} maxLength - Maximum length (0 = no truncation)
 * @returns {Object} { content, truncated, originalLength }
 */
function truncateContent(content, maxLength) {
  if (maxLength === 0) {
    return { content, truncated: false, originalLength: null };
  }

  // Handle different content types
  let stringContent;
  if (typeof content === "string") {
    stringContent = content;
  } else if (Array.isArray(content)) {
    stringContent = JSON.stringify(content);
  } else if (typeof content === "object" && content !== null) {
    stringContent = JSON.stringify(content);
  } else {
    return { content, truncated: false, originalLength: null };
  }

  const originalLength = stringContent.length;

  if (originalLength <= maxLength) {
    return { content, truncated: false, originalLength };
  }

  // Truncate and add indicator
  const truncated = stringContent.substring(0, maxLength);
  const indicator = `... [truncated, ${originalLength - maxLength} chars omitted]`;

  // Try to parse back to original type if it was JSON
  if (typeof content !== "string") {
    try {
      return {
        content: truncated + indicator,
        truncated: true,
        originalLength,
      };
    } catch {
      return {
        content: truncated + indicator,
        truncated: true,
        originalLength,
      };
    }
  }

  return {
    content: truncated + indicator,
    truncated: true,
    originalLength,
  };
}

/**
 * Extract hostname and port from URL
 * @param {string} url - Full URL
 * @returns {Object} { hostname, port }
 */
function parseDestinationUrl(url) {
  try {
    const parsed = new URL(url);
    return {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      protocol: parsed.protocol.replace(":", ""),
    };
  } catch {
    return { hostname: null, port: null, protocol: null };
  }
}

/**
 * Create audit logger wrapper with convenience methods
 * @param {Object} config - Audit configuration from config.js
 * @returns {Object} Audit logger interface
 */
function createAuditLoggerWrapper(config) {
  if (!config.enabled) {
    // Return no-op logger if disabled
    return {
      logLlmRequest: () => {},
      logLlmResponse: () => {},
      enabled: false,
    };
  }

  const logger = createAuditLogger(config);
  const maxContentLength = config.maxContentLength || 5000;

  return {
    /**
     * Log LLM request (user message sent to provider)
     * @param {Object} context - Request context
     */
    logLlmRequest(context) {
      const {
        correlationId,
        sessionId,
        provider,
        model,
        stream,
        destinationUrl,
        userMessages,
        systemPrompt,
        tools,
        maxTokens,
      } = context;

      const { hostname, port, protocol } = parseDestinationUrl(destinationUrl);

      // Truncate messages if needed
      const truncatedMessages = truncateContent(userMessages, maxContentLength);
      const truncatedSystem = systemPrompt
        ? truncateContent(systemPrompt, maxContentLength)
        : { content: null, truncated: false };

      const logEntry = {
        type: "llm_request",
        correlationId,
        sessionId,
        provider,
        model,
        stream: stream || false,
        destinationUrl,
        destinationHostname: hostname,
        destinationPort: port,
        protocol,
        userMessages: truncatedMessages.content,
        systemPrompt: truncatedSystem.content,
        tools: Array.isArray(tools) ? tools : null,
        maxTokens: maxTokens || null,
        contentTruncated: truncatedMessages.truncated || truncatedSystem.truncated,
        msg: "LLM request initiated",
      };

      // Add original length indicators if truncated
      if (truncatedMessages.truncated) {
        logEntry.userMessagesOriginalLength = truncatedMessages.originalLength;
      }
      if (truncatedSystem.truncated) {
        logEntry.systemPromptOriginalLength = truncatedSystem.originalLength;
      }

      logger.info(logEntry);
    },

    /**
     * Log LLM response (response received from provider)
     * @param {Object} context - Response context
     */
    logLlmResponse(context) {
      const {
        correlationId,
        sessionId,
        provider,
        model,
        stream,
        destinationUrl,
        destinationHostname,
        destinationIp,
        destinationIpFamily,
        assistantMessage,
        stopReason,
        requestTokens,
        responseTokens,
        latencyMs,
        status,
        error,
        streamingNote,
      } = context;

      const { hostname, port, protocol } = parseDestinationUrl(destinationUrl);

      // Truncate response content if needed (but not for streaming)
      let truncatedMessage = { content: null, truncated: false };
      if (assistantMessage && !stream) {
        truncatedMessage = truncateContent(assistantMessage, maxContentLength);
      }

      const logEntry = {
        type: "llm_response",
        correlationId,
        sessionId,
        provider,
        model,
        stream: stream || false,
        destinationUrl,
        destinationHostname: destinationHostname || hostname,
        destinationPort: port,
        destinationIp: destinationIp || null,
        destinationIpFamily: destinationIpFamily || null,
        protocol,
        status: status || null,
        latencyMs: latencyMs || null,
        msg: error ? "LLM request failed" : "LLM response received",
      };

      // Add response content for non-streaming
      if (!stream && assistantMessage) {
        logEntry.assistantMessage = truncatedMessage.content;
        logEntry.stopReason = stopReason || null;
        logEntry.contentTruncated = truncatedMessage.truncated;
        if (truncatedMessage.truncated) {
          logEntry.assistantMessageOriginalLength = truncatedMessage.originalLength;
        }
      }

      // Add streaming note if applicable
      if (stream && streamingNote) {
        logEntry.streamingNote = streamingNote;
      }

      // Add token usage
      if (requestTokens || responseTokens) {
        logEntry.usage = {
          requestTokens: requestTokens || null,
          responseTokens: responseTokens || null,
          totalTokens: (requestTokens || 0) + (responseTokens || 0),
        };
      }

      // Add error details if present
      if (error) {
        logEntry.error = typeof error === "string" ? error : error.message || "Unknown error";
        logEntry.errorStack = error.stack || null;
      }

      logger.info(logEntry);
    },

    /**
     * Log query-response pair with full content (NO truncation)
     * This is logged AFTER the response for easy query/response correlation
     * @param {Object} context - Query-response context
     */
    logQueryResponsePair(context) {
      const {
        correlationId,
        sessionId,
        provider,
        model,
        requestTime,
        responseTime,
        userQuery,
        assistantResponse,
        stopReason,
        latencyMs,
        requestTokens,
        responseTokens,
      } = context;

      const logEntry = {
        type: "llm_query_response_pair",
        correlationId,
        sessionId,
        provider,
        model,
        requestTime,
        responseTime,
        latencyMs: latencyMs || null,
        userQuery, // Full query, NO truncation
        assistantResponse, // Full response, NO truncation
        stopReason: stopReason || null,
        msg: "Query-response pair (full content)",
      };

      // Add token usage if available
      if (requestTokens || responseTokens) {
        logEntry.usage = {
          requestTokens: requestTokens || null,
          responseTokens: responseTokens || null,
          totalTokens: (requestTokens || 0) + (responseTokens || 0),
        };
      }

      logger.info(logEntry);
    },

    enabled: true,
  };
}

module.exports = {
  createAuditLogger: createAuditLoggerWrapper,
  truncateContent,
  parseDestinationUrl,
};
