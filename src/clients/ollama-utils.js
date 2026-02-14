const config = require("../config");
const logger = require("../logger");

// Cache for model capabilities
const modelCapabilitiesCache = new Map();

/**
 * Known models with tool calling support
 */
const TOOL_CAPABLE_MODELS = new Set([
  "llama3.1",
  "llama3.2",
  "qwen2.5",
  "mistral",
  "mistral-nemo",
  "firefunction-v2",
  "kimi-k2.5",
  "nemotron",
  "glm-4",
  "glm4",
]);

/**
 * Check if a model name indicates tool support
 */
function modelNameSupportsTools(modelName) {
  if (!modelName) return false;

  const normalized = modelName.toLowerCase();

  // Check if model name starts with any known tool-capable model
  return Array.from(TOOL_CAPABLE_MODELS).some(prefix =>
    normalized.startsWith(prefix)
  );
}

/**
 * Check if Ollama model supports tool calling
 * Uses heuristics and caching to avoid repeated API calls
 */
async function checkOllamaToolSupport(modelName = config.ollama?.model) {
  if (!modelName) return false;

  // Check cache
  if (modelCapabilitiesCache.has(modelName)) {
    return modelCapabilitiesCache.get(modelName);
  }

  // Quick heuristic check based on model name
  const supportsTools = modelNameSupportsTools(modelName);

  logger.debug({ modelName, supportsTools }, "Ollama tool support check");

  // Cache the result
  modelCapabilitiesCache.set(modelName, supportsTools);

  return supportsTools;
}

/**
 * Convert Anthropic tool format to Ollama format
 *
 * Anthropic format:
 * {
 *   name: "get_weather",
 *   description: "Get weather",
 *   input_schema: { type: "object", properties: {...}, required: [...] }
 * }
 *
 * Ollama format:
 * {
 *   type: "function",
 *   function: {
 *     name: "get_weather",
 *     description: "Get weather",
 *     parameters: { type: "object", properties: {...}, required: [...] }
 *   }
 * }
 */
function convertAnthropicToolsToOllama(anthropicTools) {
  if (!Array.isArray(anthropicTools) || anthropicTools.length === 0) {
    return [];
  }

  return anthropicTools.map(tool => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.input_schema || {
        type: "object",
        properties: {},
      },
    },
  }));
}

// Regex for validating shell commands (shared by bullet-point and fenced-block strategies)
const SHELL_COMMAND_RE = /^(git|ls|cd|cat|head|tail|grep|find|mkdir|rm|cp|mv|pwd|echo|curl|wget|npm|node|python|pip|docker|kubectl|make|go|cargo|rustc)\b/;

/**
 * Strategy: JSON tool call format {"name": "...", "parameters": {...}}
 * @param {string} text
 * @returns {object[]|null}
 */
function jsonToolCall(text) {
  const startMatch = text.match(/\{\s*"name"\s*:/);
  if (!startMatch) return null;

  const startIdx = startMatch.index;
  let braceCount = 0;
  let endIdx = -1;
  for (let i = startIdx; i < text.length; i++) {
    if (text[i] === '{') braceCount++;
    else if (text[i] === '}') {
      braceCount--;
      if (braceCount === 0) {
        endIdx = i + 1;
        break;
      }
    }
  }

  if (endIdx === -1) return null;

  try {
    const parsed = JSON.parse(text.substring(startIdx, endIdx));
    if (parsed.name && parsed.parameters) {
      logger.info({
        toolName: parsed.name,
        originalText: text.substring(0, 200)
      }, "Extracted JSON tool call from text (jsonToolCall strategy)");
      return [{
        function: {
          name: parsed.name,
          arguments: parsed.parameters
        }
      }];
    }
  } catch (e) {
    logger.debug({ error: e.message }, "Failed to parse JSON tool call from text");
  }
  return null;
}

/**
 * Strategy: Bullet-point shell commands (● cmd, • cmd, - cmd, * cmd)
 * GLM and similar models sometimes output commands as bullet points instead of tool_calls
 * @param {string} text
 * @returns {object[]|null}
 */
function bulletPointCommands(text) {
  const results = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const match = line.match(/^\s*[●•\-\*❯>]\s+(.+)$/);
    if (match) {
      const command = match[1].trim();
      if (SHELL_COMMAND_RE.test(command)) {
        logger.info({
          command,
          originalLine: line.trim()
        }, "Extracted shell command from bullet-point text (bulletPointCommands strategy)");
        results.push({
          function: {
            name: "Bash",
            arguments: { command }
          }
        });
      }
    }
  }
  return results.length > 0 ? results : null;
}

/**
 * Strategy: Fenced code block commands (```bash, ```sh, ```shell, etc.)
 * Some models output shell commands inside markdown code blocks
 * @param {string} text
 * @returns {object[]|null}
 */
function fencedCodeBlockCommands(text) {
  const results = [];
  // Match ```bash, ```sh, ```shell, ```zsh, ```console, ```terminal (with optional whitespace)
  const fenceRe = /```(?:bash|sh|shell|zsh|console|terminal)\s*\n([\s\S]*?)```/gi;
  let fenceMatch;
  while ((fenceMatch = fenceRe.exec(text)) !== null) {
    const blockContent = fenceMatch[1];
    const lines = blockContent.split('\n');
    for (const line of lines) {
      // Strip leading $ or # prompt characters
      const cleaned = line.replace(/^\s*[$#]\s*/, '').trim();
      if (!cleaned) continue;
      if (SHELL_COMMAND_RE.test(cleaned)) {
        logger.info({
          command: cleaned,
          originalBlock: blockContent.substring(0, 200)
        }, "Extracted shell command from fenced code block (fencedCodeBlockCommands strategy)");
        results.push({
          function: {
            name: "Bash",
            arguments: { command: cleaned }
          }
        });
      }
    }
  }
  return results.length > 0 ? results : null;
}

// Registry: model prefix → ordered list of extraction strategy names
const MODEL_TOOL_STRATEGIES = {
  "glm": ["bulletPointCommands", "fencedCodeBlockCommands"],
  // Add more models as needed:
  // "deepseek": ["fencedCodeBlockCommands"],
};

// Strategy functions (each returns array of tool calls or null)
const EXTRACTION_STRATEGIES = {
  jsonToolCall,
  bulletPointCommands,
  fencedCodeBlockCommands,
};

/**
 * Extract tool calls from text when LLM outputs them as text instead of using tool_calls.
 *
 * Uses a registry-based approach: model name prefixes map to ordered lists of
 * extraction strategies. JSON extraction always runs first (universal).
 *
 * @param {string} text - Text content that may contain tool calls
 * @param {string} [modelName] - Optional model name for model-specific strategies
 * @returns {object[]|null} - Array of tool call objects in Ollama format, or null if none found
 */
function extractToolCallsFromText(text, modelName) {
  if (!text || typeof text !== 'string') return null;

  // Always try JSON first (universal)
  const jsonResults = jsonToolCall(text);
  if (jsonResults) return jsonResults;

  // Determine which strategies to try
  let strategies = [];
  if (config.aggressiveToolPatching) {
    // Try everything
    strategies = Object.keys(EXTRACTION_STRATEGIES).filter(k => k !== 'jsonToolCall');
  } else if (modelName) {
    // Model-specific strategies
    const normalized = modelName.toLowerCase();
    for (const [prefix, strats] of Object.entries(MODEL_TOOL_STRATEGIES)) {
      if (normalized.startsWith(prefix)) {
        strategies = strats;
        break;
      }
    }
  }

  for (const stratName of strategies) {
    const fn = EXTRACTION_STRATEGIES[stratName];
    if (!fn) continue;
    const results = fn(text);
    if (results) {
      logger.info({ strategy: stratName, modelName, count: results.length }, "Tool extraction matched via strategy registry");
      return results;
    }
  }

  return null;
}

// Backward-compatible wrapper — returns first match only
function extractToolCallFromText(text, modelName) {
  const results = extractToolCallsFromText(text, modelName);
  return results ? results[0] : null;
}

/**
 * Convert Ollama tool call response to Anthropic format
 *
 * Ollama format (actual):
 * {
 *   message: {
 *     role: "assistant",
 *     content: "",
 *     tool_calls: [{
 *       function: {
 *         name: "get_weather",
 *         arguments: { location: "SF" }  // Already parsed object
 *       }
 *     }]
 *   }
 * }
 *
 * Anthropic format:
 * {
 *   content: [{
 *     type: "tool_use",
 *     id: "toolu_123",
 *     name: "get_weather",
 *     input: { location: "SF" }
 *   }],
 *   stop_reason: "tool_use"
 * }
 */
function convertOllamaToolCallsToAnthropic(ollamaResponse) {
  const message = ollamaResponse?.message || {};
  let toolCalls = message.tool_calls || [];
  const textContent = message.content || "";

  // FALLBACK: If no tool_calls but text contains JSON tool call, parse it
  if (toolCalls.length === 0 && textContent) {
    const extracted = extractToolCallFromText(textContent);
    if (extracted) {
      logger.info({ extractedTool: extracted.function?.name }, "Using fallback text parsing for tool call");
      toolCalls = [extracted];
    }
  }

  const contentBlocks = [];

  // Add text content if present
  if (textContent && textContent.trim()) {
    contentBlocks.push({
      type: "text",
      text: textContent,
    });
  }

  // Add tool calls
  for (const toolCall of toolCalls) {
    const func = toolCall.function || {};
    let input = {};

    // Handle arguments - can be string JSON or already parsed object
    if (func.arguments) {
      if (typeof func.arguments === "string") {
        try {
          input = JSON.parse(func.arguments);
        } catch (err) {
          logger.warn({
            error: err.message,
            arguments: func.arguments
          }, "Failed to parse Ollama tool arguments string");
          input = {};
        }
      } else if (typeof func.arguments === "object") {
        // Already an object, use directly
        input = func.arguments;
      }
    }

    // Generate tool use ID (Ollama may or may not provide one)
    const toolUseId = toolCall.id || `toolu_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    contentBlocks.push({
      type: "tool_use",
      id: toolUseId,
      name: func.name || "unknown",
      input,
    });
  }

  // Determine stop reason
  const stopReason = toolCalls.length > 0 ? "tool_use" : "end_turn";

  return {
    contentBlocks,
    stopReason,
  };
}

/**
 * Build complete Anthropic response from Ollama with tool calls
 */
function buildAnthropicResponseFromOllama(ollamaResponse, requestedModel) {
  const { contentBlocks, stopReason } = convertOllamaToolCallsToAnthropic(ollamaResponse);

  // Ensure at least one content block
  const finalContent = contentBlocks.length > 0
    ? contentBlocks
    : [{ type: "text", text: "" }];

  // Extract token counts
  const inputTokens = ollamaResponse.prompt_eval_count || 0;
  const outputTokens = ollamaResponse.eval_count || 0;

  return {
    id: `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: requestedModel,
    content: finalContent,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

module.exports = {
  checkOllamaToolSupport,
  convertAnthropicToolsToOllama,
  convertOllamaToolCallsToAnthropic,
  buildAnthropicResponseFromOllama,
  modelNameSupportsTools,
  extractToolCallFromText,
  extractToolCallsFromText,
  MODEL_TOOL_STRATEGIES,
};
