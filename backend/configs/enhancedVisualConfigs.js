/**
 * Deprecated compatibility shim.
 *
 * The app now has ONE active config file for QnA visuals and prompts:
 *   backend/configs/openAiSystemConfigs.js
 *
 * This file only re-exports the new config so any old imports do not crash.
 * Safe to delete once no files import it anymore.
 */

const { PHIA_QNA_CONFIG, VISUAL_SYSTEM } = require("./openAiSystemConfigs");

module.exports = {
  ENHANCED_VISUAL_CONFIG: PHIA_QNA_CONFIG,
  VISUAL_SYSTEM,
};