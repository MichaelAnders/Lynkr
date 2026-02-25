const assert = require("assert");
const { describe, it, beforeEach, afterEach } = require("node:test");

describe("MODEL_DEFAULT Configuration Tests", () => {
  let originalEnv;

  beforeEach(() => {
    delete require.cache[require.resolve("../src/config")];
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("defaultModel", () => {
    it("should be null when MODEL_DEFAULT is not set", () => {
      delete process.env.MODEL_DEFAULT;
      delete process.env.MODEL_PROVIDER;
      const config = require("../src/config");

      assert.strictEqual(config.modelProvider.defaultModel, null);
    });

    it("should use MODEL_DEFAULT when explicitly set", () => {
      process.env.MODEL_PROVIDER = "openrouter";
      process.env.MODEL_DEFAULT = "qwen/qwen3-coder-next";
      delete require.cache[require.resolve("../src/config")];
      const config = require("../src/config");

      assert.strictEqual(config.modelProvider.defaultModel, "qwen/qwen3-coder-next");
    });

    it("should trim whitespace from MODEL_DEFAULT", () => {
      process.env.MODEL_PROVIDER = "openrouter";
      process.env.MODEL_DEFAULT = "  qwen/qwen3-coder-next  ";
      delete require.cache[require.resolve("../src/config")];
      const config = require("../src/config");

      assert.strictEqual(config.modelProvider.defaultModel, "qwen/qwen3-coder-next");
    });

    it("should be null when MODEL_DEFAULT is empty string", () => {
      process.env.MODEL_PROVIDER = "openrouter";
      process.env.MODEL_DEFAULT = "";
      delete require.cache[require.resolve("../src/config")];
      const config = require("../src/config");

      assert.strictEqual(config.modelProvider.defaultModel, null);
    });

    it("should be null when MODEL_DEFAULT is whitespace only", () => {
      process.env.MODEL_PROVIDER = "openrouter";
      process.env.MODEL_DEFAULT = "   ";
      delete require.cache[require.resolve("../src/config")];
      const config = require("../src/config");

      assert.strictEqual(config.modelProvider.defaultModel, null);
    });
  });
});
