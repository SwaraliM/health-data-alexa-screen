/**
 * backend/services/qna/intentClassifierService.js
 *
 * Intent classifier for natural language understanding.
 * Translates raw Alexa utterances into structured intent before routing.
 *
 * Flow: User Speech → Intent Classifier → Router → Planner/Control Handler
 */

const { AGENT_CONFIGS } = require("../../configs/agentConfigs");
const { createResponse } = require("../openai/responsesClient");

const CLASSIFIER_DEBUG = process.env.QNA_CLASSIFIER_DEBUG !== "false";

function classifierLog(message, data = null) {
  if (!CLASSIFIER_DEBUG) return;
  if (data == null) return console.log(`[IntentClassifier] ${message}`);
  console.log(`[IntentClassifier] ${message}`, data);
}

function classifierWarn(message, data = null) {
  if (data == null) return console.warn(`[IntentClassifier] ${message}`);
  console.warn(`[IntentClassifier] ${message}`, data);
}

function sanitizeText(value, max = 300, fallback = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : fallback;
}

/**
 * Build fallback intent when classification fails or is disabled.
 * Treats input as a new health question so existing flow still works.
 */
function buildFallbackIntent(userText = "") {
  return {
    intent_type: "new_health_question",
    normalized_question: sanitizeText(userText, 300, ""),
    user_interest: {
      primary_metric: "",
      temporal_focus: "recent_days",
      comparison_type: "none",
      concern_level: "curious",
    },
    control_action: "none",
    conversational_context: {
      references_previous_content: false,
      implicit_continuation: false,
      conversational_cues: [],
    },
    confidence: 0.5,
    fallback_needed: false,
    explicit_metrics: [],
    inferred_metrics: [],
    rich_analysis_goal: sanitizeText(userText, 300, ""),
    time_range: "last_7_days",
    is_navigation: false,
    _source: "fallback",
  };
}

/**
 * Build user message for classifier including session context.
 */
function buildClassifierUserMessage(userText, sessionContext = {}) {
  const {
    hasPriorBundle = false,
    priorQuestion = null,
  } = sessionContext;

  const lines = [];
  lines.push(`USER SAID: ${sanitizeText(userText, 300, "")}`);
  lines.push("");

  if (hasPriorBundle && priorQuestion) {
    lines.push(`PRIOR CONTEXT: User previously asked: "${sanitizeText(priorQuestion, 120, "")}"`);
  } else {
    lines.push("PRIOR CONTEXT: No prior question in this session.");
  }

  lines.push("");
  lines.push("CLASSIFY THIS INTENT.");

  return lines.join("\n");
}

/**
 * Validate and normalize classifier output before returning.
 */
function normalizeClassifierOutput(raw) {
  if (!raw || typeof raw !== "object") return null;

  const validIntentTypes = [
    "new_health_question",
    "navigation_control",
    "clarification_request",
    "exploration_request",
    "comparison_request",
    "general_conversation",
  ];
  const validControlActions = [
    "none", "show_more", "go_back", "replay", "start_over", "go_deeper", "explain_current", "skip_ahead",
  ];
  const validTemporalFocus = [
    "right_now", "today", "last_night", "yesterday", "this_week", "last_week",
    "recent_days", "this_month", "trend_over_time", "specific_date",
  ];
  const validComparisonTypes = ["none", "vs_goal", "vs_average", "vs_past", "vs_other_metric"];
  const validConcernLevels = ["curious", "concerned", "tracking_goal", "investigating_issue"];

  const intentType = validIntentTypes.includes(raw.intent_type)
    ? raw.intent_type
    : "new_health_question";

  const normalizedQuestion = sanitizeText(raw.normalized_question, 300, "");

  const rawInterest = raw.user_interest && typeof raw.user_interest === "object"
    ? raw.user_interest
    : {};
  const userInterest = {
    primary_metric: sanitizeText(rawInterest.primary_metric, 40, ""),
    temporal_focus: validTemporalFocus.includes(rawInterest.temporal_focus)
      ? rawInterest.temporal_focus
      : "recent_days",
    comparison_type: validComparisonTypes.includes(rawInterest.comparison_type)
      ? rawInterest.comparison_type
      : "none",
    concern_level: validConcernLevels.includes(rawInterest.concern_level)
      ? rawInterest.concern_level
      : "curious",
  };

  const controlAction = validControlActions.includes(raw.control_action)
    ? raw.control_action
    : "none";

  const rawCtx = raw.conversational_context && typeof raw.conversational_context === "object"
    ? raw.conversational_context
    : {};
  const conversationalContext = {
    references_previous_content: Boolean(rawCtx.references_previous_content),
    implicit_continuation: Boolean(rawCtx.implicit_continuation),
    conversational_cues: Array.isArray(rawCtx.conversational_cues)
      ? rawCtx.conversational_cues.slice(0, 5).map((c) => sanitizeText(c, 60, "")).filter(Boolean)
      : [],
  };

  const rawConfidence = Number(raw.confidence);
  const confidence = Number.isFinite(rawConfidence)
    ? Math.min(1.0, Math.max(0.0, rawConfidence))
    : 0.5;

  const fallbackNeeded = Boolean(raw.fallback_needed) || confidence < 0.5;

  const explicitMetrics = Array.isArray(raw.explicit_metrics)
    ? raw.explicit_metrics.slice(0, 6).map((m) => sanitizeText(m, 40, "")).filter(Boolean)
    : [];

  const inferredMetrics = Array.isArray(raw.inferred_metrics)
    ? raw.inferred_metrics.slice(0, 8).map((m) => sanitizeText(m, 40, "")).filter(Boolean)
    : [];

  const richAnalysisGoal = sanitizeText(raw.rich_analysis_goal, 300, normalizedQuestion);
  const timeRange = sanitizeText(raw.time_range, 40, "last_7_days") || "last_7_days";
  const isNavigation = Boolean(raw.is_navigation);

  return {
    intent_type: intentType,
    normalized_question: normalizedQuestion,
    user_interest: userInterest,
    control_action: controlAction,
    conversational_context: conversationalContext,
    confidence,
    fallback_needed: fallbackNeeded,
    explicit_metrics: explicitMetrics,
    inferred_metrics: inferredMetrics,
    rich_analysis_goal: richAnalysisGoal,
    time_range: timeRange,
    is_navigation: isNavigation,
    _source: "classifier",
  };
}

/**
 * Simple deterministic hash for A/B rollout: given a string, returns a number 0-99.
 */
function rolloutHash(text) {
  let hash = 0;
  const str = String(text || "");
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hash % 100;
}

/**
 * Classify a user utterance into structured intent.
 *
 * @param {string} userText - Raw speech from Alexa
 * @param {object} sessionContext - Current session state
 * @param {boolean} [sessionContext.hasPriorBundle]
 * @param {string} [sessionContext.priorQuestion]
 * @returns {Promise<object>} Classified intent with is_navigation, inferred_metrics, rich_analysis_goal
 */
async function classifyIntent(userText, sessionContext = {}) {
  const classifierConfig = AGENT_CONFIGS.intentClassifier;
  const safeText = sanitizeText(userText, 300, "");

  // Check if classifier feature is enabled globally.
  if (!classifierConfig.enabled) {
    classifierLog("classifier disabled via USE_INTENT_CLASSIFIER=false, using fallback");
    return buildFallbackIntent(safeText);
  }

  // Check rollout percentage: 0 = off for all traffic, 100 = on for all.
  const rolloutPercent = classifierConfig.rolloutPercent;
  if (rolloutPercent <= 0) {
    classifierLog("classifier rollout=0, using fallback");
    return buildFallbackIntent(safeText);
  }

  if (rolloutPercent < 100) {
    // Hash based on text + current minute to distribute across requests.
    const hashInput = safeText + String(Math.floor(Date.now() / 60000));
    const bucket = rolloutHash(hashInput);
    if (bucket >= rolloutPercent) {
      classifierLog("classifier rollout bucket miss, using fallback", { bucket, rolloutPercent });
      return buildFallbackIntent(safeText);
    }
  }

  if (!safeText) {
    classifierLog("empty userText, using fallback");
    return buildFallbackIntent("");
  }

  const userMessage = buildClassifierUserMessage(safeText, sessionContext);

  try {
    classifierLog("calling classifier", {
      textPreview: safeText.slice(0, 80),
      hasActiveBundle: Boolean(sessionContext.hasActiveBundle),
    });

    const response = await createResponse({
      model: classifierConfig.model,
      input: userMessage,
      instructions: classifierConfig.systemPrompt,
      responseFormat: classifierConfig.textFormat,
      temperature: classifierConfig.temperature,
      maxOutputTokens: classifierConfig.maxOutputTokens,
      timeoutMs: classifierConfig.timeoutMs,
      metadata: {
        agent: "intent_classifier",
        version: classifierConfig.version,
      },
    });

    if (!response?.ok) {
      classifierWarn("classifier request failed, using fallback", {
        status: response?.status || "unknown",
        error: response?.error || "",
      });
      return buildFallbackIntent(safeText);
    }

    const rawOutput = response.outputJson || null;
    if (!rawOutput) {
      classifierWarn("classifier returned no JSON output, using fallback");
      return buildFallbackIntent(safeText);
    }

    const normalized = normalizeClassifierOutput(rawOutput);
    if (!normalized) {
      classifierWarn("classifier output normalization failed, using fallback");
      return buildFallbackIntent(safeText);
    }

    classifierLog("classification result", {
      intent_type: normalized.intent_type,
      is_navigation: normalized.is_navigation,
      inferred_metrics: normalized.inferred_metrics,
      time_range: normalized.time_range,
      confidence: normalized.confidence,
      fallback_needed: normalized.fallback_needed,
      responseId: response.responseId,
    });

    return normalized;
  } catch (error) {
    console.error("[IntentClassifier] classify failed, using fallback", {
      message: error?.message || String(error),
    });
    return buildFallbackIntent(safeText);
  }
}

module.exports = { classifyIntent, buildFallbackIntent };
