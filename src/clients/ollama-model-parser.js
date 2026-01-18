const config = require('../config');
const logger = require('../logger');

/**
 * Parse model string to extract Ollama model override
 * @param {string} modelString - Model string from request (e.g., "ollama/mistral2")
 * @returns {string|null} - Ollama model name or null if not ollama format
 */
function parseOllamaModel(modelString) {
  if (!modelString || typeof modelString !== 'string') {
    return null;
  }

  const ollamaPrefix = 'ollama/';
  if (!modelString.startsWith(ollamaPrefix)) {
    return null;
  }

  const modelName = modelString.slice(ollamaPrefix.length).trim();

  if (!modelName) {
    throw new Error('Empty model name in ollama/ format');
  }

  return modelName;
}

/**
 * Validate that an Ollama model is available
 * @param {string} modelName - Model name to validate
 * @returns {Promise<{available: boolean, error: string|null, availableModels: string[]}>}
 */
async function validateOllamaModel(modelName) {
  try {
    const ollamaEndpoint = config.ollama.endpoint || 'http://localhost:11434';
    const tagsUrl = `${ollamaEndpoint}/api/tags`;

    logger.debug({
      tool: "ollama_validation",
      modelName,
      destinationUrl: tagsUrl,
      destinationHostname: new URL(tagsUrl).hostname,
    }, `Validating Ollama model '${modelName}'`);

    // Use AbortController for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(tagsUrl, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json'
      }
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      logger.error({
        tool: "ollama_validation",
        status: response.status,
        destinationUrl: tagsUrl,
        destinationHostname: new URL(tagsUrl).hostname,
      }, `Ollama /api/tags returned status ${response.status}`);
      return {
        available: false,
        error: `Unable to retrieve available models from Ollama (status ${response.status})`,
        availableModels: []
      };
    }

    const data = await response.json();

    if (!data || !Array.isArray(data.models)) {
      logger.error('Invalid response from Ollama /api/tags endpoint');
      return {
        available: false,
        error: 'Unable to retrieve available models from Ollama',
        availableModels: []
      };
    }

    const availableModels = data.models.map(m => m.name);
    const isAvailable = availableModels.includes(modelName);

    if (!isAvailable) {
      logger.warn(`Ollama model '${modelName}' not found. Available: ${availableModels.join(', ')}`);
      return {
        available: false,
        error: buildModelNotFoundError(modelName, availableModels),
        availableModels
      };
    }

    logger.debug({
      tool: "ollama_validation",
      modelName,
      status: response.status,
      destinationUrl: tagsUrl,
      destinationHostname: new URL(tagsUrl).hostname,
      availableModelsCount: availableModels.length,
    }, `Ollama model '${modelName}' validated successfully`);
    return {
      available: true,
      error: null,
      availableModels
    };

  } catch (error) {
    logger.error('Error validating Ollama model:', error.message);

    if (error.name === 'AbortError') {
      return {
        available: false,
        error: `Timeout connecting to Ollama at ${config.ollama.endpoint || 'http://localhost:11434'}`,
        availableModels: []
      };
    }

    if (error.cause?.code === 'ECONNREFUSED' || error.message.includes('ECONNREFUSED')) {
      return {
        available: false,
        error: `Cannot connect to Ollama at ${config.ollama.endpoint || 'http://localhost:11434'}. Is Ollama running?`,
        availableModels: []
      };
    }

    return {
      available: false,
      error: `Error checking model availability: ${error.message}`,
      availableModels: []
    };
  }
}

/**
 * Build helpful error message for model not found
 * @param {string} modelName - Requested model name
 * @param {string[]} availableModels - List of available models
 * @returns {string} - Error message
 */
function buildModelNotFoundError(modelName, availableModels) {
  const modelsList = availableModels.length > 0
    ? availableModels.join(', ')
    : 'none';

  return `Ollama model '${modelName}' is not available.\nModel not found. Available models: ${modelsList}.\nPlease pull the model with: ollama pull ${modelName}`;
}

module.exports = {
  parseOllamaModel,
  validateOllamaModel
};
