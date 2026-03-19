/**
 * Legacy compatibility stub.
 *
 * The new QnA flow no longer uses the old GPTChat class.
 * OpenAI calls now go through services/openaiClient.js so that:
 * - prompts are centralized,
 * - timeouts are consistent,
 * - the renderer stays deterministic.
 */

class GPTChat {
    constructor() {
      throw new Error(
        "GPTChat is deprecated. Use backend/services/openaiClient.js instead."
      );
    }
  }
  
  module.exports = GPTChat;