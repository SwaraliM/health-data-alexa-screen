/**
 * backend/services/qna/responseBuilder.js
 *
 * Single source of truth for response formatting.
 * Extracted from alexaRouter.js and qnaOrchestrator.js.
 */

"use strict";

const { buildStagePayload } = require("./stageService");

function sanitizeText(value, max = 800, fallback = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : fallback;
}

/**
 * Build a stage result that the orchestrator returns to the router.
 * Contains both the voice answer and the full payload for WebSocket/frontend.
 */
function buildStageResult({
  bundle = null,
  stage = null,
  requestId = null,
  voiceAnswerSource = "gpt",
  stageCount = null,
} = {}) {
  const payload = buildStagePayload({
    bundle,
    stageRecord: stage,
    question: bundle?.displayLabel || bundle?.question || "",
    requestId,
    voiceAnswerSource,
    stageCountOverride: stageCount,
  });
  const activeStageIndex = Math.max(0, Number(stage?.stageIndex || payload?.activeStageIndex || 0));
  const bundleComplete = Boolean(payload?.bundle_complete);
  const resolvedStageCount = stageCount || Number(payload.stageCount || 1);

  return {
    ok: true,
    status: bundleComplete ? "complete" : "ready",
    answer_ready: true,
    voice_answer: payload.voice_answer,
    requestId: requestId || payload.requestId || null,
    stageCount: resolvedStageCount,
    activeStageIndex,
    bundle_complete: bundleComplete,
    payload,
    stage,
    bundleId: bundle?.bundleId || null,
  };
}

/**
 * Build a pending response when the pipeline hasn't completed yet.
 */
function buildPendingResponse({
  bundle = null,
  requestId = null,
  voiceAnswer = "Hang on, I'm still pulling your data. Ask me again in a moment.",
  activeStageIndex = 0,
  stageCount = null,
} = {}) {
  const resolvedStageCount = stageCount
    || (Array.isArray(bundle?.stagesPlan) ? bundle.stagesPlan.length : 1);

  return {
    ok: false,
    status: "pending",
    answer_ready: false,
    voice_answer: sanitizeText(voiceAnswer, 220, "Still working on that."),
    requestId: requestId || null,
    stageCount: resolvedStageCount,
    activeStageIndex: Math.max(0, Number(activeStageIndex) || 0),
    bundle_complete: false,
    payload: null,
    bundleId: bundle?.bundleId || null,
  };
}

/**
 * Build the terminal response when all charts have been shown.
 */
function buildTerminalResponse({ bundle = null, requestId = null, stageCount = null } = {}) {
  const voiceAnswer = "That was the last chart in this analysis. Ask a new health question, or say go deeper.";
  return {
    ok: true,
    status: "complete",
    answer_ready: true,
    voice_answer: voiceAnswer,
    requestId: requestId || null,
    stageCount: stageCount || (Array.isArray(bundle?.stagesPlan) ? bundle.stagesPlan.length : 1),
    activeStageIndex: Math.max(0, Number(bundle?.currentStageIndex || 0)),
    bundle_complete: true,
    payload: null,
    bundleId: bundle?.bundleId || null,
  };
}

/**
 * Format the orchestrator result into the Lambda response shape.
 * Lambda expects: { GPTresponse: string, smallTalk: string }
 */
function buildLambdaResponse(result) {
  if (!result) return { GPTresponse: "I had some trouble. Please try again.", smallTalk: "" };

  const voice = String(
    result.voice_answer || result.voiceAnswer || ""
  ).replace(/\s+/g, " ").trim();

  return {
    GPTresponse: voice || "Here are your results.",
    smallTalk: "",
  };
}

module.exports = {
  buildStageResult,
  buildPendingResponse,
  buildTerminalResponse,
  buildLambdaResponse,
  sanitizeText,
};
