/**
 * backend/services/qna/chartQnaClassifier.js
 *
 * Lightweight LLM classifier that decides whether a follow-up utterance
 * is asking about the currently displayed chart ("chart_qna") or is a
 * brand-new health question ("new_health_question").
 *
 * On any failure (timeout, parse error, disabled), defaults to
 * "new_health_question" so the existing pipeline is never blocked.
 */

"use strict";

const { AGENT_CONFIGS } = require("../../configs/agentConfigs");
const { createResponse } = require("../openai/responsesClient");

const DEBUG = process.env.QNA_CHART_QNA_DEBUG !== "false";

function log(message, data = null) {
  if (!DEBUG) return;
  if (data == null) return console.log(`[ChartQnaClassifier] ${message}`);
  console.log(`[ChartQnaClassifier] ${message}`, data);
}

function warn(message, data = null) {
  if (data == null) return console.warn(`[ChartQnaClassifier] ${message}`);
  console.warn(`[ChartQnaClassifier] ${message}`, data);
}

function sanitizeText(value, max = 320, fallback = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : fallback;
}

function buildClassifierInput(utterance, chartContext = {}) {
  return {
    utterance: sanitizeText(utterance, 320, ""),
    current_chart: {
      title: sanitizeText(chartContext.title, 120, ""),
      chart_type: sanitizeText(chartContext.chart_type, 40, ""),
      metrics: Array.isArray(chartContext.metrics) ? chartContext.metrics.slice(0, 8) : [],
      time_scope: sanitizeText(chartContext.time_scope, 40, ""),
      stage_index: Number(chartContext.stage_index ?? 0),
      stage_count: Number(chartContext.stage_count ?? 1),
      spoken_text: sanitizeText(chartContext.spoken_text, 300, ""),
    },
    original_question: sanitizeText(chartContext.original_question, 320, ""),
  };
}

// Canonical metrics the classifier is allowed to request as supplemental
const ALLOWED_SUPPLEMENTAL_METRICS = new Set([
  "sleep_minutes", "sleep_deep", "sleep_rem", "sleep_light", "sleep_awake", "sleep_efficiency",
  "resting_hr", "hrv", "steps", "calories", "distance", "floors",
]);

function normalizeSupplementalMetrics(raw = []) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((m) => sanitizeText(m, 40, "").toLowerCase())
    .filter((m) => m && ALLOWED_SUPPLEMENTAL_METRICS.has(m))
    .slice(0, 2);
}

/**
 * Classify whether the utterance is a chart follow-up or a new question.
 *
 * @param {string} utterance
 * @param {object} chartContext - { title, chart_type, metrics, time_scope, stage_index, stage_count, spoken_text, original_question }
 * @returns {Promise<{
 *   turn_type: "chart_qna" | "chart_qna_with_fetch" | "new_health_question",
 *   confidence: number,
 *   reason: string,
 *   supplemental_metrics: string[]
 * }>}
 */
async function classifyChartFollowup(utterance, chartContext = {}) {
  const config = AGENT_CONFIGS.chartQna;
  if (!config?.enabled) {
    log("chart QnA disabled, defaulting to new_health_question");
    return { turn_type: "new_health_question", confidence: 0.5, reason: "feature_disabled", supplemental_metrics: [] };
  }

  const safeUtterance = sanitizeText(utterance, 320, "");
  if (!safeUtterance) {
    return { turn_type: "new_health_question", confidence: 0.5, reason: "empty_utterance", supplemental_metrics: [] };
  }

  const input = buildClassifierInput(safeUtterance, chartContext);

  try {
    log("classifying", { utterance: safeUtterance.slice(0, 80), chartTitle: chartContext.title });

    const response = await createResponse({
      model: config.classifierModel,
      input: JSON.stringify(input),
      instructions: config.classifierSystemPrompt,
      responseFormat: config.classifierTextFormat,
      temperature: config.temperature,
      timeoutMs: config.classifierTimeoutMs,
      metadata: { agent: "chart_qna_classifier", version: config.version },
    });

    if (!response?.ok) {
      warn("classifier request failed, defaulting to new_health_question", {
        status: response?.status,
        error: response?.error,
      });
      return { turn_type: "new_health_question", confidence: 0.5, reason: "classifier_error", supplemental_metrics: [] };
    }

    const raw = response.outputJson || null;
    if (!raw || typeof raw !== "object") {
      warn("classifier returned no valid JSON");
      return { turn_type: "new_health_question", confidence: 0.5, reason: "no_json_output", supplemental_metrics: [] };
    }

    const rawConfidence = Number(raw.confidence);
    const confidence = Number.isFinite(rawConfidence) ? Math.min(1, Math.max(0, rawConfidence)) : 0.5;
    const reason = sanitizeText(raw.reason, 120, "");
    const supplementalMetrics = normalizeSupplementalMetrics(raw.supplemental_metrics);

    let turnType = "new_health_question";
    if (raw.turn_type === "chart_qna") {
      turnType = "chart_qna";
    } else if (raw.turn_type === "chart_qna_with_fetch") {
      // Downgrade to plain chart_qna if no valid supplemental metrics came back
      turnType = supplementalMetrics.length > 0 ? "chart_qna_with_fetch" : "chart_qna";
    }

    log("classification result", { turnType, confidence, reason, supplementalMetrics });

    return { turn_type: turnType, confidence, reason, supplemental_metrics: supplementalMetrics };
  } catch (error) {
    warn("classifier threw, defaulting to new_health_question", {
      message: error?.message || String(error),
    });
    return { turn_type: "new_health_question", confidence: 0.5, reason: "classifier_exception", supplemental_metrics: [] };
  }
}

module.exports = { classifyChartFollowup, ALLOWED_SUPPLEMENTAL_METRICS };
