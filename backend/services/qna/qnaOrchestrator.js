/**
 * backend/services/qna/qnaOrchestrator.js
 *
 * Phase 4 primary orchestrator.
 *
 * Responsibilities:
 * - planner + continuation decision
 * - bundle action management (continue / branch / new)
 * - Fitbit fetch + lightweight normalization into bundle memory
 * - executor-first single-stage generation with response chaining
 * - legacy qnaEngine fallback for safety/timing compatibility
 */

const mongoose = require("mongoose");
const {
  answerFollowupFromPayload,
  answerQuestion,
  buildFitbitInternalUrl,
  getUserContext,
  inferHeuristicFetchPlan,
} = require("../qnaEngine");
const {
  adaptCaloriesRange,
  adaptDistanceRange,
  adaptElevationRange,
  adaptFloorsRange,
  adaptHrvRange,
  adaptIntradayActivity,
  adaptIntradayHeart,
  adaptRestingHeartRateRange,
  adaptSleepRange,
  adaptStepsRange,
} = require("../fitbit/endpointAdapters");
const { resolveRequestedMetrics } = require("../fitbit/metricResolver");
const { buildNormalizedTable } = require("../fitbit/normalizeSeries");
const { generateInitialStage, generateNextStage } = require("./executorAgent");
const { analyzeFollowupIntent, classifyContinuation } = require("./continuationAgent");
const {
  buildCompletionState,
  buildStageResponse,
  buildLegacyFallbackStage,
  getLatestStage,
  normalizeRequestedStageIndex,
  replayStoredStage,
  extractStageSummary,
  getNextStageIndex,
} = require("./stageService");
const {
  applyStageReplayState,
  beginRequest,
  endRequest,
  getActiveBundleId,
  getActiveSessionState,
  getSessionState,
  isCurrentRequest,
  isStaleRequest,
  setActiveBundleForUser,
  setActiveBundleId,
  setCurrentStageIndex: setSessionStageIndex,
  setLatestRequestKey,
  setRequestBundleOwnership,
  setRequestedStageIndex,
} = require("./sessionService");
const {
  appendOrUpdateStageAndState,
  archiveOlderActiveBundles,
  createBranchBundle,
  createBundle,
  getBundleById,
  loadActiveBundleForUser,
  releaseOlderActiveBundles,
  saveBundlePatch,
  setBundleRequestOwnership,
  setCurrentStageIndex: setBundleStageIndex,
  setBundleStatus,
  storePlannerResult,
  toStoredPlannerResult,
  touchBundle,
} = require("./bundleService");
const { recordSessionAudit } = require("./auditService");
const { buildCompactBundleSummary, planQuestion } = require("./plannerAgent");
const { AGENT_CONFIGS } = require("../../configs/agentConfigs");

const ORCHESTRATOR_DEBUG = process.env.QNA_ORCHESTRATOR_DEBUG !== "false";
// Primary path: planner -> bundle -> executor. Do not set to "false" if you want executor as primary.
const ORCHESTRATOR_PRIMARY_ENABLED = process.env.QNA_ORCHESTRATOR_PRIMARY !== "false";
const SHADOW_MODE_ENABLED = process.env.QNA_PLANNER_SHADOW_MODE !== "false";
const EXECUTOR_PRIMARY_ENABLED = AGENT_CONFIGS.executor?.primaryEnabled !== false
  && process.env.QNA_EXECUTOR_STAGE_ENABLED !== "false";
const EXECUTOR_ALLOW_STAGE1_FALLBACK = AGENT_CONFIGS.executor?.fallback?.useLegacyStage1Fallback !== false;
const EXECUTOR_ALLOW_NAV_FALLBACK = AGENT_CONFIGS.executor?.fallback?.useLegacyNavigationFallback !== false;
const EXECUTOR_MAX_STAGE_COUNT = Math.max(
  1,
  Math.floor(Number(AGENT_CONFIGS.executor?.progression?.maxStages || 4))
);
const EXECUTOR_MIN_STAGE_COUNT = Math.min(
  EXECUTOR_MAX_STAGE_COUNT,
  Math.max(1, Math.floor(Number(AGENT_CONFIGS.executor?.progression?.minStages || 2)))
);
const EXECUTOR_COMPLETE_BUNDLES_ON_FINAL_STAGE = AGENT_CONFIGS.executor?.progression?.completeBundleOnFinalStage === true;
const BUNDLE_LIFECYCLE_POLICY = String(process.env.QNA_BUNDLE_LIFECYCLE_POLICY || "archive").toLowerCase();
const BUNDLE_DATA_FETCH_TIMEOUT_MS = Number(process.env.QNA_BUNDLE_FETCH_TIMEOUT_MS || 4800);
const STRICT_STALE_RESULT_REJECTION = AGENT_CONFIGS?.session?.strictStaleResultRejection !== false;
const TERMINAL_STAGE_VOICE_ANSWER = "That was the last visual for this question. Ask another health question when you're ready.";
const TERMINAL_STAGE_REASONS = new Set(["max_stage_count_reached", "no_more_stages"]);

const TIME_SCOPE_DAY_CONFIG = {
  today: { days: 1, offset: 0 },
  yesterday: { days: 1, offset: 1 },
  last_night: { days: 1, offset: 1 },
  this_week: { days: 7, offset: 0 },
  last_week: { days: 7, offset: 7 },
  last_7_days: { days: 7, offset: 0 },
  last_30_days: { days: 30, offset: 0 },
};

function orchestratorLog(message, data = null) {
  if (!ORCHESTRATOR_DEBUG) return;
  if (data == null) return console.log(`[QnaOrchestrator] ${message}`);
  console.log(`[QnaOrchestrator] ${message}`, data);
}

function orchestratorWarn(message, data = null) {
  if (data == null) return console.warn(`[QnaOrchestrator] ${message}`);
  console.warn(`[QnaOrchestrator] ${message}`, data);
}

function orchestratorError(message, error = null) {
  if (!error) return console.error(`[QnaOrchestrator] ${message}`);
  console.error(`[QnaOrchestrator] ${message}`, {
    message: error?.message || String(error),
    stack: error?.stack || null,
  });
}

function normalizeUsername(username = "") {
  return String(username || "").trim().toLowerCase();
}

function sanitizeQuestion(question = "") {
  return String(question || "").replace(/\s+/g, " ").trim();
}

function sanitizeText(value, max = 220, fallback = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : fallback;
}

function asNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeFollowupPhrase(value = "") {
  return sanitizeText(value, 120, "").toLowerCase();
}

function enforceContinuationFollowups(followups = [], moreAvailable = false) {
  const unique = [];
  const blockedWhenComplete = new Set(["show more", "yes", "next", "more", "go on", "continue"]);
  const append = (value) => {
    const normalized = normalizeFollowupPhrase(value);
    if (!normalized) return;
    if (!moreAvailable && blockedWhenComplete.has(normalized)) return;
    if (unique.includes(normalized)) return;
    unique.push(normalized);
  };

  (Array.isArray(followups) ? followups : []).forEach((value) => append(value));
  if (moreAvailable) {
    if (!unique.includes("show more")) unique.unshift("show more");
    if (!unique.includes("yes")) unique.splice(unique.includes("show more") ? 1 : 0, 0, "yes");
  }
  return unique.slice(0, 6);
}

function applyStageProgressionPolicy(stageRecord = null) {
  if (!stageRecord || typeof stageRecord !== "object") return stageRecord;
  const stageIndex = Math.max(0, Number(stageRecord.stageIndex) || 0);
  const beforeMinimum = stageIndex < (EXECUTOR_MIN_STAGE_COUNT - 1);
  const atOrBeyondMaximum = stageIndex >= (EXECUTOR_MAX_STAGE_COUNT - 1);
  const moreAvailable = atOrBeyondMaximum
    ? false
    : (beforeMinimum ? true : Boolean(stageRecord.moreAvailable));

  return {
    ...stageRecord,
    stageIndex,
    moreAvailable,
    suggestedFollowups: enforceContinuationFollowups(stageRecord.suggestedFollowups, moreAvailable),
  };
}

function isTerminalStageReason(reason = "") {
  return TERMINAL_STAGE_REASONS.has(String(reason || "").trim().toLowerCase());
}

function buildTerminalStageResult({
  reason = "stage_sequence_complete",
  bundle = null,
  requestId = null,
  question = "",
  voiceAnswerSource = "gpt",
} = {}) {
  const latestStage = getLatestStage(bundle);
  let payload = null;
  if (bundle?.bundleId && latestStage) {
    const stageResponse = buildStageResponse({
      bundle,
      stageRecord: latestStage,
      question,
      requestId,
      voiceAnswerSource,
      completeWhenDone: EXECUTOR_COMPLETE_BUNDLES_ON_FINAL_STAGE,
    });
    if (stageResponse?.payload) {
      payload = {
        ...stageResponse.payload,
        status: "ready",
        answer_ready: true,
        payload_ready: true,
        voice_answer_source: stageResponse.payload.voice_answer_source || voiceAnswerSource,
        voice_answer: TERMINAL_STAGE_VOICE_ANSWER,
        spoken_answer: TERMINAL_STAGE_VOICE_ANSWER,
        suggested_followup_prompt: "Ask another health question to start a new visual analysis.",
      };
    }
  }
  if (!payload) {
    payload = {
      status: "ready",
      requestId: requestId || null,
      answer_ready: true,
      payload_ready: true,
      voice_answer_source: voiceAnswerSource,
      voice_answer: TERMINAL_STAGE_VOICE_ANSWER,
      spoken_answer: TERMINAL_STAGE_VOICE_ANSWER,
      question: sanitizeText(question, 280, ""),
      stageCount: Array.isArray(bundle?.stages) ? bundle.stages.length : 0,
      activeStageIndex: Number(bundle?.currentStageIndex || 0),
    };
  }
  return {
    ok: true,
    status: "complete",
    answerReady: true,
    reason,
    voiceAnswerSource,
    voiceAnswer: TERMINAL_STAGE_VOICE_ANSWER,
    payload,
    bundleId: bundle?.bundleId || null,
  };
}

function isMongoReady() {
  return mongoose?.connection?.readyState === 1;
}

function resolveOrchestratorDeps(overrides = null) {
  const defaults = {
    answerFollowupFromPayload,
    analyzeFollowupIntent,
    applyStageReplayState,
    beginRequest,
    branchBundle,
    buildLegacyFallbackStage,
    classifyContinuation,
    continueExistingBundle,
    endRequest,
    ensureBundleHasNormalizedData,
    finalizeBundleIfDone,
    getActiveBundleId,
    getActiveSessionState,
    getBundleById,
    getLatestStage,
    generateNextMissingStage,
    generateOrReplayStage,
    getNextStageIndex,
    getSessionState,
    getUserContext,
    isMongoReady,
    isCurrentRequest,
    isStaleRequest,
    loadActiveBundleForUser,
    persistStageResult,
    planQuestion,
    recordSessionAudit,
    replayStoredStage,
    runLegacyStage1,
    setActiveBundleForUser,
    setActiveBundleId,
    setBundleRequestOwnership,
    setBundleStageIndex,
    setBundleStatus,
    setLatestRequestKey,
    setRequestBundleOwnership,
    setRequestedStageIndex,
    setSessionStageIndex,
    shouldGenerateNextStage,
    startNewBundleFromPlanner,
    tryExecutorStageGeneration,
  };
  if (!overrides || typeof overrides !== "object") return defaults;
  return {
    ...defaults,
    ...overrides,
  };
}

function makeRequestKey(requestId = null) {
  if (requestId && String(requestId).trim()) return String(requestId).trim();
  return `req_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function isCurrentRequestGuard(services, username, requestKey, bundleId = null) {
  if (!requestKey) return true;
  if (typeof services?.isCurrentRequest === "function") {
    return services.isCurrentRequest({
      username,
      requestKey,
      bundleId: bundleId || null,
    });
  }
  if (typeof services?.isStaleRequest === "function") {
    return !services.isStaleRequest(username, requestKey);
  }
  return true;
}

function recordStaleDiscard(services, {
  username,
  bundleId = null,
  requestKey = null,
  source = "internal",
  reason = "stale_result_discarded",
  scope = "orchestrator",
} = {}) {
  if (typeof services?.recordSessionAudit !== "function") return;
  services.recordSessionAudit({
    eventType: "stale_result_discarded",
    username,
    bundleId,
    requestKey,
    source,
    reason,
    result: scope,
  });
}

function staleResultResponse({
  reason = "stale_result_discarded",
  bundleId = null,
} = {}) {
  return {
    ok: false,
    stale: true,
    status: "stale",
    reason,
    answerReady: false,
    voiceAnswerSource: "fallback",
    voiceAnswer: "",
    payload: null,
    bundleId: bundleId || null,
    orchestrator: {
      used: true,
      stageGenerator: "stale_discarded",
      fallbackReason: reason,
      bundleId: bundleId || null,
    },
  };
}

async function bindRequestToBundle({
  services,
  username,
  requestKey,
  bundleId,
  source = "internal",
} = {}) {
  if (!bundleId) return;
  try {
    if (typeof services?.setRequestBundleOwnership === "function") {
      services.setRequestBundleOwnership({
        username,
        requestKey,
        bundleId,
      });
    }
  } catch (error) {
    orchestratorWarn("failed to set in-memory request bundle ownership", {
      username,
      bundleId,
      requestKey,
      message: error?.message || String(error),
    });
  }

  try {
    if (typeof services?.setBundleRequestOwnership === "function") {
      await services.setBundleRequestOwnership(bundleId, requestKey, source);
    }
  } catch (error) {
    orchestratorWarn("failed to persist bundle request ownership", {
      username,
      bundleId,
      requestKey,
      message: error?.message || String(error),
    });
  }
}

function parseStageIndexInput(input = null) {
  if (typeof input === "number" && Number.isFinite(input)) {
    return Math.max(0, Math.floor(input));
  }
  const raw = String(input == null ? "" : input).trim().toLowerCase();
  if (!raw) return null;
  const parsed = Number(raw.replace(/[^\d-]/g, ""));
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.floor(parsed));
}

function normalizeNavigationAction(action = "") {
  const value = String(action || "").trim().toLowerCase();
  if (["stage_next", "next", "show_more"].includes(value)) return "stage_next";
  if (["stage_back", "back", "previous"].includes(value)) return "stage_back";
  if (["stage_replay", "replay"].includes(value)) return "stage_replay";
  if (["stage_goto", "go_to_stage", "goto_stage"].includes(value)) return "stage_goto";
  return value;
}

function parseNonNegativeInt(value, fallback = null) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
}

function sanitizeSessionHints(sessionHints = null) {
  if (!sessionHints || typeof sessionHints !== "object") return null;
  const normalized = {
    activeStageIndex: parseNonNegativeInt(sessionHints.activeStageIndex, null),
    stageCount: parseNonNegativeInt(sessionHints.stageCount, null),
    pendingAction: sanitizeText(sessionHints.pendingAction, 40, ""),
    lastQuestion: sanitizeQuestion(sessionHints.lastQuestion || ""),
  };
  const hasValues = normalized.activeStageIndex != null
    || normalized.stageCount != null
    || Boolean(normalized.pendingAction)
    || Boolean(normalized.lastQuestion);
  return hasValues ? normalized : null;
}

function applySessionHintsToRequest({
  services,
  username,
  sessionHints = null,
  requestKey = null,
} = {}) {
  const hints = sanitizeSessionHints(sessionHints);
  if (!hints || !services || !username) return hints;

  try {
    if (requestKey && typeof services.setLatestRequestKey === "function") {
      services.setLatestRequestKey(username, requestKey);
    }
    if (hints.activeStageIndex != null) {
      if (typeof services.setSessionStageIndex === "function") {
        services.setSessionStageIndex(username, hints.activeStageIndex);
      }
      if (typeof services.setRequestedStageIndex === "function") {
        services.setRequestedStageIndex(username, hints.activeStageIndex);
      }
    }
  } catch (error) {
    orchestratorWarn("failed to apply session hints", {
      username,
      message: error?.message || String(error),
      hints,
    });
  }

  return hints;
}

function normalizeControlAction(action = "") {
  const value = String(action || "").trim().toLowerCase();
  if ([
    "show_more",
    "next",
    "more",
    "tell_me_more",
    "go_on",
    "stage_next",
  ].includes(value)) return "show_more";
  if (["back", "go_back", "previous", "stage_back"].includes(value)) return "back";
  if (["replay", "repeat", "stage_replay"].includes(value)) return "replay";
  if (["stage_goto", "goto_stage", "go_to_stage", "goto"].includes(value)) return "goto_stage";
  if (["compare", "comparison", "compare_that"].includes(value)) return "compare";
  if ([
    "explain",
    "description",
    "what_does_this_mean",
    "why_is_that",
    "what_stands_out",
    "what_am_i_looking_at",
  ].includes(value)) return "explain";
  if (["summarize", "summary", "recap"].includes(value)) return "summarize";
  if (["start_over", "restart", "reset"].includes(value)) return "start_over";
  return value;
}

function resolveControlQuestion({
  action,
  question = "",
  sessionHints = null,
} = {}) {
  const normalizedAction = normalizeControlAction(action);
  const explicitQuestion = sanitizeQuestion(question || "");
  if (explicitQuestion) return explicitQuestion;
  if (normalizedAction === "compare") {
    return "Compare this stage with the previous period in one narrated chart stage.";
  }
  if (normalizedAction === "explain") {
    return "Explain this stage in plain language: what is on screen, what stands out, and what it means.";
  }
  if (normalizedAction === "summarize") {
    return "Summarize this stage in one clear takeaway.";
  }
  const hintedQuestion = sanitizeQuestion(sessionHints?.lastQuestion || "");
  if (hintedQuestion && normalizedAction !== "start_over") return hintedQuestion;
  if (normalizedAction === "show_more") return "Show more.";
  if (normalizedAction === "back") return "Go back.";
  if (normalizedAction === "start_over") return "Start over with a fresh chart-by-chart analysis.";
  return "";
}

function buildControlActionQuestion({
  action = "",
  stage = null,
  fallbackQuestion = "",
} = {}) {
  const normalizedAction = normalizeControlAction(action);
  const stageTitle = sanitizeText(stage?.title, 80, "");
  const stageReference = stageTitle
    ? `the current stage titled "${stageTitle}"`
    : "the current stage";
  const explicit = sanitizeQuestion(fallbackQuestion || "");
  if (explicit) return explicit;

  if (normalizedAction === "compare") {
    return `Compare ${stageReference} with the previous period and generate one narrated comparison stage.`;
  }
  if (normalizedAction === "explain") {
    return `Explain ${stageReference} in simple terms for an older adult. Describe what is on screen, what stands out, and what it means.`;
  }
  if (normalizedAction === "summarize") {
    return `Summarize ${stageReference} as one narrated takeaway stage in plain language.`;
  }

  return sanitizeQuestion(fallbackQuestion || "");
}

function toBundlePlannerPayload(plannerResult = {}) {
  return {
    ...toStoredPlannerResult(plannerResult),
    phase: "phase4_primary",
  };
}

function buildActiveBundleSummary(bundle) {
  return buildCompactBundleSummary(bundle);
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function computeDateWindow(timeScope = "last_7_days") {
  const key = String(timeScope || "last_7_days").toLowerCase();
  const config = TIME_SCOPE_DAY_CONFIG[key] || TIME_SCOPE_DAY_CONFIG.last_7_days;
  const now = new Date();
  const end = new Date(now);
  end.setDate(now.getDate() - Number(config.offset || 0));
  const start = new Date(end);
  start.setDate(end.getDate() - (Math.max(1, Number(config.days || 7)) - 1));
  return {
    timeScope: key,
    startDate: formatDate(start),
    endDate: formatDate(end),
  };
}

function resolveTimeScope(plannerResult = null, bundle = null, question = "") {
  const fromPlanner = String(plannerResult?.timeScope || plannerResult?.time_scope || "").trim().toLowerCase();
  if (fromPlanner) return fromPlanner;
  const fromBundle = String(bundle?.plannerOutput?.time_scope || bundle?.plannerOutput?.timeScope || "").trim().toLowerCase();
  if (fromBundle) return fromBundle;
  const heuristic = inferHeuristicFetchPlan(question || "");
  return String(heuristic?.time_scope || "last_7_days").toLowerCase();
}

function mapMetricPayload(metric, payload) {
  const metricKey = String(metric || "").toLowerCase();
  if (metricKey === "steps") return adaptStepsRange(payload);
  if (metricKey === "calories") return adaptCaloriesRange(payload);
  if (metricKey === "distance") return adaptDistanceRange(payload);
  if (metricKey === "floors") return adaptFloorsRange(payload);
  if (metricKey === "elevation") return adaptElevationRange(payload);
  if (metricKey === "sleep_minutes") return adaptSleepRange(payload);
  if (metricKey === "resting_hr") return adaptRestingHeartRateRange(payload);
  if (metricKey === "hrv") return adaptHrvRange(payload);
  if (metricKey === "heart_intraday") return adaptIntradayHeart(payload);
  if (metricKey.endsWith("_intraday")) {
    const resource = metricKey.replace(/_intraday$/, "");
    return adaptIntradayActivity(payload, resource);
  }
  // Conservative fallback keeps data flow alive.
  return adaptStepsRange(payload);
}

async function fetchJsonWithTimeout(url, timeoutMs = BUNDLE_DATA_FETCH_TIMEOUT_MS) {
  const ms = Math.max(1200, asNumber(timeoutMs, BUNDLE_DATA_FETCH_TIMEOUT_MS));
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), ms) : null;
  try {
    const response = await fetch(url, { signal: controller?.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}: ${sanitizeText(body, 160, "fetch failed")}`);
    }
    return await response.json();
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Phase 4 lightweight data hydration:
 * - fetch planner-requested metrics from internal Fitbit proxy endpoints
 * - adapt endpoint-specific payloads into normalized point lists
 * - build a GPT-friendly wide normalized table
 */
async function ensureBundleHasNormalizedData({
  bundle,
  username,
  question,
  plannerResult = null,
  fetchTimeoutMs = null,
} = {}) {
  if (!bundle?.bundleId) return bundle;

  const metricsFromPlanner = resolveRequestedMetrics(plannerResult?.metricsNeeded || plannerResult?.metrics_needed || []);
  const existingMetrics = Array.isArray(bundle.metricsRequested) ? bundle.metricsRequested : [];
  const heuristicMetrics = resolveRequestedMetrics(inferHeuristicFetchPlan(question || "").metrics_needed || []);
  const metrics = resolveRequestedMetrics([...metricsFromPlanner, ...existingMetrics, ...heuristicMetrics]).slice(0, 8);
  const timeScope = resolveTimeScope(plannerResult, bundle, question);
  const window = computeDateWindow(timeScope);

  const existingCache = bundle.rawFitbitCache && typeof bundle.rawFitbitCache === "object"
    ? { ...bundle.rawFitbitCache }
    : {};
  const metricSeriesMap = {};

  for (const metric of metrics) {
    const cacheEntry = existingCache[metric];
    const isReusable = cacheEntry
      && cacheEntry.timeScope === timeScope
      && cacheEntry.startDate === window.startDate
      && cacheEntry.endDate === window.endDate
      && Array.isArray(cacheEntry.adaptedPoints)
      && cacheEntry.adaptedPoints.length > 0;

    if (isReusable) {
      metricSeriesMap[metric] = cacheEntry.adaptedPoints;
      continue;
    }

    const url = buildFitbitInternalUrl({
      username,
      metricKey: metric,
      startDate: window.startDate,
      endDate: window.endDate,
      timeScope,
    });

    try {
      const raw = await fetchJsonWithTimeout(url, fetchTimeoutMs || BUNDLE_DATA_FETCH_TIMEOUT_MS);
      const adaptedPoints = mapMetricPayload(metric, raw);
      metricSeriesMap[metric] = adaptedPoints;
      existingCache[metric] = {
        metric,
        timeScope,
        startDate: window.startDate,
        endDate: window.endDate,
        fetchedAt: new Date().toISOString(),
        sourceUrl: url,
        raw,
        adaptedPoints,
      };
    } catch (error) {
      orchestratorWarn("metric fetch failed during bundle hydration", {
        bundleId: bundle.bundleId,
        metric,
        message: error?.message || String(error),
      });
      metricSeriesMap[metric] = [];
      existingCache[metric] = {
        metric,
        timeScope,
        startDate: window.startDate,
        endDate: window.endDate,
        fetchedAt: new Date().toISOString(),
        sourceUrl: url,
        raw: null,
        adaptedPoints: [],
        error: sanitizeText(error?.message, 200, "fetch_failed"),
      };
    }
  }

  const normalizedTable = buildNormalizedTable(metricSeriesMap);
  const patched = await saveBundlePatch(bundle.bundleId, {
    metricsRequested: metrics,
    rawFitbitCache: existingCache,
    normalizedTable,
  });

  orchestratorLog("bundle normalized data ready", {
    bundleId: bundle.bundleId,
    metrics,
    normalizedRows: Array.isArray(normalizedTable) ? normalizedTable.length : 0,
  });

  return patched || bundle;
}

/**
 * Decide normalized bundle action from planner + continuation layer.
 */
function resolveBundleAction({ activeBundle, plannerResult, continuationDecision } = {}) {
  if (!activeBundle?.bundleId) {
    return {
      action: "new",
      reason: "no_active_bundle",
    };
  }

  const decision = String(continuationDecision || "").toLowerCase();
  if (decision === "branch") {
    return { action: "branch", reason: "continuation_agent_branch" };
  }
  if (decision === "new") {
    return { action: "new", reason: "continuation_agent_new" };
  }
  if (decision === "continue") {
    return { action: "continue", reason: "continuation_agent_continue" };
  }

  const plannerMode = String(plannerResult?.mode || "").toLowerCase();
  if (plannerMode === "branch_analysis") return { action: "branch", reason: "planner_mode" };
  if (plannerMode === "new_analysis") return { action: "new", reason: "planner_mode" };
  return { action: "continue", reason: "safe_default" };
}

async function storePlannerResultInBundle(bundleId, plannerResult) {
  const normalizedPlannerResult = {
    ...plannerResult,
    rawPlannerOutput: plannerResult?.rawPlannerOutput || null,
  };
  const updated = await storePlannerResult(bundleId, {
    ...normalizedPlannerResult,
    plannerMeta: {
      ...(normalizedPlannerResult.plannerMeta || {}),
      phase: "phase4_primary",
    },
  });
  return updated || null;
}

async function applyLifecyclePolicyForNewBundle({ username, keepBundleId = null, activeBundle = null } = {}) {
  const mode = BUNDLE_LIFECYCLE_POLICY;
  if (mode === "none") {
    orchestratorLog("bundle lifecycle policy skipped", {
      mode,
      username,
      keepBundleId,
      activeBundleId: activeBundle?.bundleId || null,
    });
    return;
  }

  if (mode === "release") {
    await releaseOlderActiveBundles(username, keepBundleId, "new_analysis_release_policy");
    return;
  }

  await archiveOlderActiveBundles(username, keepBundleId, "new_analysis_archive_policy");
}

async function startNewBundleFromPlanner({
  username,
  question,
  plannerResult,
  activeBundle = null,
  reason = "new_analysis",
  requestKey = null,
  requestSource = "alexa",
} = {}) {
  const createdBundle = await createBundle({
    username,
    question,
    plannerOutput: toBundlePlannerPayload(plannerResult),
    metricsRequested: plannerResult?.metricsNeeded || [],
    status: "active",
    requestKey,
    requestSource,
  });

  await storePlannerResultInBundle(createdBundle.bundleId, plannerResult);
  await applyLifecyclePolicyForNewBundle({
    username,
    keepBundleId: createdBundle.bundleId,
    activeBundle,
  });

  orchestratorLog("started new bundle from planner", {
    username,
    bundleId: createdBundle.bundleId,
    previousBundleId: activeBundle?.bundleId || null,
    reason,
    lifecyclePolicy: BUNDLE_LIFECYCLE_POLICY,
  });

  return createdBundle;
}

async function continueExistingBundle({ activeBundle, plannerResult } = {}) {
  if (!activeBundle?.bundleId) return null;
  await storePlannerResultInBundle(activeBundle.bundleId, plannerResult);
  await setBundleStatus(activeBundle.bundleId, "active", {}, "continue_existing_bundle");
  await touchBundle(activeBundle.bundleId);
  return getBundleById(activeBundle.bundleId);
}

async function branchBundle({
  activeBundle,
  username,
  question,
  plannerResult,
  requestKey = null,
  requestSource = "followup",
} = {}) {
  if (!activeBundle?.bundleId) {
    return startNewBundleFromPlanner({
      username,
      question,
      plannerResult,
      activeBundle: null,
      reason: "branch_without_active_bundle",
      requestKey,
      requestSource,
    });
  }

  const branchDoc = await createBranchBundle({
    sourceBundle: activeBundle,
    username,
    question,
    plannerOutput: toBundlePlannerPayload(plannerResult),
    metricsRequested: plannerResult?.metricsNeeded || [],
    requestKey,
    requestSource,
  });
  await storePlannerResultInBundle(branchDoc.bundleId, plannerResult);
  return getBundleById(branchDoc.bundleId);
}

async function persistStageResult({
  bundle,
  stageRecord,
  executorResponseId = null,
  statusReason = "stage_persisted",
  requestKey = null,
  rejectStaleRequest = false,
} = {}) {
  if (!bundle?.bundleId || !stageRecord) return null;
  const governedStageRecord = applyStageProgressionPolicy(stageRecord);

  const reloaded = await appendOrUpdateStageAndState({
    bundleId: bundle.bundleId,
    stageRecord: governedStageRecord,
    executorResponseId: executorResponseId != null ? executorResponseId : bundle.executorResponseId || null,
    completeWhenDone: EXECUTOR_COMPLETE_BUNDLES_ON_FINAL_STAGE,
    statusReason,
    requestKey,
    rejectStaleRequest,
  });
  if (!reloaded) return null;

  const completionState = buildCompletionState({
    bundle: reloaded,
    stageRecord: governedStageRecord,
    completeWhenDone: EXECUTOR_COMPLETE_BUNDLES_ON_FINAL_STAGE,
  });

  return {
    bundle: reloaded,
    stageRecord: governedStageRecord,
    stageSummary: extractStageSummary(governedStageRecord),
    completionState,
  };
}

async function runLegacyStage1({
  requestId = null,
  username,
  question,
  userContext = null,
  voiceDeadlineMs = null,
  allowFetchPlannerLLM = true,
  allowPresenterLLM = true,
  enableVisualContinuation = true,
  fetchPlanTimeoutMs,
  fetchTimeoutMs = null,
} = {}) {
  return answerQuestion({
    requestId,
    username,
    question,
    userContext,
    voiceDeadlineMs,
    allowFetchPlannerLLM,
    allowPresenterLLM,
    enableVisualContinuation,
    fetchPlanTimeoutMs,
    fetchTimeoutMs,
  });
}

function shouldGenerateNextStage(bundleAction, continuation, bundle) {
  const stages = Array.isArray(bundle?.stages) ? bundle.stages : [];
  if (!stages.length) return false;
  if (bundleAction?.action !== "continue") return false;
  if (String(continuation?.decision || "").toLowerCase() !== "continue") return false;
  return true;
}

async function tryExecutorStageGeneration({
  requestId,
  requestKey = null,
  requestSource = "alexa",
  username,
  question,
  userContext,
  plannerResult,
  bundleAction,
  continuation,
  resolvedBundle,
  voiceDeadlineMs,
  explicitStageIndex = null,
  deps = null,
} = {}) {
  const services = resolveOrchestratorDeps(deps);
  const safeRequestKey = makeRequestKey(requestKey || requestId);

  if (!EXECUTOR_PRIMARY_ENABLED) {
    orchestratorWarn("executor disabled; legacy will be used for stage1", { username, bundleId: resolvedBundle?.bundleId || null });
    return {
      ok: false,
      reason: "executor_disabled",
    };
  }
  if (!resolvedBundle?.bundleId) {
    return {
      ok: false,
      reason: "missing_bundle",
    };
  }

  if (STRICT_STALE_RESULT_REJECTION && !isCurrentRequestGuard(services, username, safeRequestKey, resolvedBundle.bundleId)) {
    return {
      ok: false,
      stale: true,
      reason: "stale_request_discarded",
      status: "stale",
      bundle: resolvedBundle,
    };
  }

  const hasExplicitStageIndex = explicitStageIndex != null && explicitStageIndex !== "";
  const generateNext = hasExplicitStageIndex
    ? true
    : shouldGenerateNextStage(bundleAction, continuation, resolvedBundle);
  const stageIndex = hasExplicitStageIndex
    ? Math.max(0, Number(explicitStageIndex) || 0)
    : (generateNext ? getNextStageIndex(resolvedBundle) : 0);
  if (stageIndex >= EXECUTOR_MAX_STAGE_COUNT) {
    return {
      ok: false,
      reason: "max_stage_count_reached",
      status: "completed",
    };
  }

  const generatorInput = {
    bundle: resolvedBundle,
    question,
    userContext,
    voiceDeadlineMs,
    requestId,
    previousResponseId: resolvedBundle.executorResponseId || null,
    toolContext: {
      username,
      bundleId: resolvedBundle.bundleId,
      requestKey: safeRequestKey,
      source: requestSource,
      canWriteToBundle: ({ bundleId, requestKey: toolRequestKey, username: writeUsername } = {}) => {
        if (!bundleId || !toolRequestKey || !writeUsername) return false;
        return isCurrentRequestGuard(services, writeUsername, toolRequestKey, bundleId);
      },
      markBundleComplete: async ({ reason } = {}) => {
        await setBundleStatus(
          resolvedBundle.bundleId,
          "completed",
          {},
          reason || "executor_mark_complete_tool",
          {
            requestKey: safeRequestKey,
            rejectStaleRequest: true,
          }
        );
        return { bundleId: resolvedBundle.bundleId };
      },
      appendStageNote: async ({ note } = {}) => {
        const existing = await services.getBundleById(resolvedBundle.bundleId);
        const lineage = {
          ...(existing?.lineage || {}),
          executorNote: sanitizeText(note, 220, ""),
          executorNotedAt: new Date().toISOString(),
        };
        return saveBundlePatch(resolvedBundle.bundleId, { lineage }, {
          requestKey: safeRequestKey,
          rejectStaleRequest: true,
        });
      },
      releaseBundle: async ({ reason } = {}) => {
        return setBundleStatus(
          resolvedBundle.bundleId,
          "released",
          { releasedAt: new Date() },
          reason || "executor_release_bundle_tool",
          {
            requestKey: safeRequestKey,
            rejectStaleRequest: true,
          }
        );
      },
      fetchAdditionalFitbitData: async () => ({
        fetched: false,
        reason: "fetch_additional_fitbit_data_not_enabled",
      }),
    },
  };

  const executorResult = generateNext
    ? await generateNextStage({
        ...generatorInput,
        stageIndex,
      })
    : await generateInitialStage(generatorInput);

  if (!executorResult?.ok || !executorResult?.stage) {
    return {
      ok: false,
      reason: executorResult?.error || "executor_generation_failed",
      status: executorResult?.status || "error",
    };
  }

  if (STRICT_STALE_RESULT_REJECTION && !isCurrentRequestGuard(services, username, safeRequestKey, resolvedBundle.bundleId)) {
    return {
      ok: false,
      stale: true,
      reason: "stale_request_discarded",
      status: "stale",
      bundle: resolvedBundle,
    };
  }

  const persisted = await persistStageResult({
    bundle: resolvedBundle,
    stageRecord: executorResult.stage,
    executorResponseId: executorResult.executorResponseId || resolvedBundle.executorResponseId || null,
    statusReason: generateNext ? "executor_next_stage_persisted" : "executor_stage1_persisted",
    requestKey: safeRequestKey,
    rejectStaleRequest: true,
  });

  if (!persisted?.stageRecord) {
    return {
      ok: false,
      reason: "executor_stage_persist_failed_or_stale",
      status: "error",
    };
  }

  const stageResponse = buildStageResponse({
    bundle: persisted.bundle,
    stageRecord: persisted.stageRecord,
    question,
    requestId,
    voiceAnswerSource: "gpt",
    completeWhenDone: EXECUTOR_COMPLETE_BUNDLES_ON_FINAL_STAGE,
  });
  const payload = stageResponse.payload;

  // ── Background prefill: kick off remaining stages after stage 0 is delivered ─
  if (!generateNext && persisted?.stageRecord?.moreAvailable) {
    setTimeout(() => {
      prefillRemainingStages({
        bundle: persisted.bundle,
        username,
        question,
        plannerResult,
        userContext,
      }).catch((err) =>
        orchestratorWarn("prefillRemainingStages failed", {
          message: err?.message || String(err),
        })
      );
    }, 800);
  }
  // ─────────────────────────────────────────────────────────────────────────

  return {
    ok: true,
    stage: persisted.stageRecord,
    stageSummary: persisted.stageSummary,
    bundle: persisted.bundle,
    payload,
    completionState: stageResponse.completionState || persisted.completionState || null,
    stageGenerator: hasExplicitStageIndex
      ? "executor_requested_stage"
      : (generateNext ? "executor_next_stage" : "executor_stage1"),
  };
}

function buildStageResultEnvelope({
  payload,
  stageRecord,
  stageSummary,
  plannerResult,
  bundleId,
  bundleAction,
  continuation,
  userContext,
  stageGenerator,
  fallbackReason = null,
} = {}) {
  return {
    status: "complete",
    answerReady: true,
    voiceAnswerSource: payload?.voice_answer_source || "gpt",
    voiceAnswer: payload?.voice_answer || "",
    payload,
    planner: plannerResult,
    plannerResult,
    rawData: null,
    userContext,
    visualContinuationPromise: null,
    speechReadyPromise: null,
    bundleId: bundleId || null,
    stage: stageRecord || null,
    orchestrator: {
      used: true,
      bundleId: bundleId || null,
      bundleAction: bundleAction?.action || null,
      continuationDecision: continuation?.decision || null,
      plannerMode: plannerResult?.mode || null,
      stageSummary: stageSummary || extractStageSummary(stageRecord || {}),
      stageGenerator: stageGenerator || null,
      fallbackReason: fallbackReason || null,
    },
  };
}

function toPlannerResultFromBundle(bundle = null) {
  const planner = bundle?.plannerOutput && typeof bundle.plannerOutput === "object"
    ? bundle.plannerOutput
    : {};
  return {
    mode: planner.mode || null,
    metricsNeeded: Array.isArray(planner.metrics_needed)
      ? planner.metrics_needed
      : Array.isArray(bundle?.metricsRequested)
        ? bundle.metricsRequested
        : [],
    timeScope: planner.time_scope || planner.timeScope || null,
    analysisGoal: planner.analysis_goal || planner.analysisGoal || null,
    candidateStageTypes: Array.isArray(planner.candidate_stage_types)
      ? planner.candidate_stage_types
      : Array.isArray(planner.candidateStageTypes)
        ? planner.candidateStageTypes
        : [],
  };
}

async function finalizeBundleIfDone({
  bundle,
  stageRecord,
  deps = null,
  reason = "executor_stage_finalized",
} = {}) {
  const services = resolveOrchestratorDeps(deps);
  if (!bundle?.bundleId || !stageRecord) return bundle || null;

  const completionState = buildCompletionState({
    bundle,
    stageRecord,
    completeWhenDone: EXECUTOR_COMPLETE_BUNDLES_ON_FINAL_STAGE,
  });
  const targetStatus = completionState.bundleStatus || null;
  if (!targetStatus) return bundle;
  if (String(bundle.status || "").toLowerCase() === String(targetStatus).toLowerCase()) {
    return bundle;
  }

  const updated = await services.setBundleStatus(bundle.bundleId, targetStatus, {}, reason);
  return updated || bundle;
}

/**
 * Background prefill: generates stages 1..N immediately after stage 0 lands.
 * Fire-and-forget — never awaited on the hot path.
 */
async function prefillRemainingStages({
  bundle,
  username,
  question,
  plannerResult,
  userContext = null,
} = {}) {
  const candidateCount = Array.isArray(plannerResult?.candidateStageTypes)
    ? plannerResult.candidateStageTypes.length
    : EXECUTOR_MIN_STAGE_COUNT;
  const expectedTotal = Math.min(EXECUTOR_MAX_STAGE_COUNT, Math.max(EXECUTOR_MIN_STAGE_COUNT, candidateCount));

  let workingBundle = bundle;

  for (let nextIndex = 1; nextIndex < expectedTotal; nextIndex++) {
    try {
      // Always re-fetch so we have the latest executorResponseId + stage list
      const freshBundle = await getBundleById(workingBundle.bundleId);
      if (!freshBundle) break;

      // Skip if already generated by a concurrent request
      const alreadyExists = Array.isArray(freshBundle.stages)
        && freshBundle.stages.some((s) => Number(s?.stageIndex) === nextIndex);
      if (alreadyExists) {
        workingBundle = freshBundle;
        continue;
      }

      const result = await generateNextStage({
        bundle: freshBundle,
        question,
        stageIndex: nextIndex,
        previousResponseId: freshBundle.executorResponseId || null,
        userContext,
        voiceDeadlineMs: 7000, // relaxed — not on the voice path
        requestId: `prefill_${freshBundle.bundleId}_s${nextIndex}`,
      });

      if (!result?.ok || !result?.stage) {
        orchestratorWarn("background prefill stopped — stage generation failed", {
          bundleId: workingBundle.bundleId,
          nextIndex,
          reason: result?.error || "unknown",
        });
        break;
      }

      await persistStageResult({
        bundle: freshBundle,
        stageRecord: result.stage,
        executorResponseId: result.executorResponseId || null,
        statusReason: `background_prefill_stage_${nextIndex}`,
        rejectStaleRequest: false, // background — don't reject on ownership mismatch
      });

      orchestratorLog("background stage prefilled", {
        bundleId: workingBundle.bundleId,
        stageIndex: nextIndex,
      });

      workingBundle = await getBundleById(freshBundle.bundleId) || freshBundle;
      if (!result.stage.moreAvailable) break;

    } catch (err) {
      orchestratorWarn("background prefill error at stage", {
        bundleId: workingBundle.bundleId,
        nextIndex,
        message: err?.message || String(err),
      });
      break;
    }
  }
}

async function generateNextMissingStage({
  requestId,
  requestKey = null,
  requestSource = "internal",
  username,
  question,
  userContext,
  plannerResult,
  bundleAction,
  continuation,
  bundle,
  voiceDeadlineMs = 4200,
  targetStageIndex = null,
  deps = null,
} = {}) {
  const services = resolveOrchestratorDeps(deps);
  if (!bundle?.bundleId) {
    return {
      ok: false,
      reason: "missing_bundle",
      status: "error",
    };
  }

  if (requestKey && STRICT_STALE_RESULT_REJECTION
    && !isCurrentRequestGuard(services, username, requestKey, bundle.bundleId)) {
    return {
      ok: false,
      stale: true,
      reason: "stale_request_discarded",
      status: "stale",
      bundle,
    };
  }

  const nextStageIndex = targetStageIndex == null
    ? services.getNextStageIndex(bundle)
    : Math.max(0, Number(targetStageIndex) || 0);
  if (nextStageIndex >= EXECUTOR_MAX_STAGE_COUNT) {
    return {
      ok: false,
      reason: "max_stage_count_reached",
      status: "completed",
      requestedStageIndex: nextStageIndex,
    };
  }

  const generated = await services.tryExecutorStageGeneration({
    requestId,
    requestKey,
    requestSource,
    username,
    question,
    userContext,
    plannerResult,
    bundleAction,
    continuation,
    resolvedBundle: bundle,
    voiceDeadlineMs,
    explicitStageIndex: nextStageIndex,
    deps: services,
  });

  if (!generated?.ok || !generated?.stage) {
    return {
      ok: false,
      reason: generated?.reason || "executor_stage_generation_failed",
      status: generated?.status || "error",
      requestedStageIndex: nextStageIndex,
      bundle: generated?.bundle || bundle,
    };
  }

  const finalizedBundle = await finalizeBundleIfDone({
    bundle: generated.bundle || bundle,
    stageRecord: generated.stage,
    deps: services,
    reason: "generate_next_missing_stage_finalize",
  });

  return {
    ...generated,
    ok: true,
    bundle: finalizedBundle || generated.bundle || bundle,
  };
}

async function generateOrReplayStage({
  requestId,
  requestKey = null,
  requestSource = "internal",
  username,
  question,
  userContext = null,
  plannerResult = null,
  bundleAction = null,
  continuation = null,
  bundle,
  targetStageIndex = null,
  voiceDeadlineMs = 4200,
  preferReplay = true,
  allowGeneration = true,
  deps = null,
} = {}) {
  const services = resolveOrchestratorDeps(deps);
  if (!bundle?.bundleId) {
    return {
      ok: false,
      reason: "missing_bundle",
      status: "error",
      bundle: bundle || null,
    };
  }

  if (requestKey && STRICT_STALE_RESULT_REJECTION
    && !isCurrentRequestGuard(services, username, requestKey, bundle.bundleId)) {
    return {
      ok: false,
      stale: true,
      reason: "stale_request_discarded",
      status: "stale",
      bundle,
    };
  }

  const normalizedTarget = targetStageIndex == null
    ? null
    : Math.max(0, Number(targetStageIndex) || 0);

  if (preferReplay && normalizedTarget != null) {
    const replayed = await maybeReplayStoredStage({
      username,
      bundle,
      stageIndex: normalizedTarget,
      question,
      requestId,
      deps: services,
    });
    if (replayed?.ok && replayed?.stage && replayed?.payload) {
      return replayed;
    }
  }

  if (!allowGeneration) {
    return {
      ok: false,
      reason: "replay_not_available",
      status: "error",
      bundle,
      requestedStageIndex: normalizedTarget,
    };
  }

  if (normalizedTarget != null && normalizedTarget >= EXECUTOR_MAX_STAGE_COUNT) {
    return {
      ok: false,
      reason: "max_stage_count_reached",
      status: "completed",
      requestedStageIndex: normalizedTarget,
      bundle,
    };
  }

  let workingBundle = bundle;
  let attempts = 0;
  const maxAttempts = Math.max(1, EXECUTOR_MAX_STAGE_COUNT);

  while (attempts < maxAttempts) {
    const nextMissingIndex = services.getNextStageIndex(workingBundle);
    const stageToGenerate = normalizedTarget == null
      ? nextMissingIndex
      : Math.max(nextMissingIndex, Math.min(normalizedTarget, EXECUTOR_MAX_STAGE_COUNT - 1));

    const generated = await generateNextMissingStage({
      requestId,
      requestKey,
      requestSource,
      username,
      question,
      userContext,
      plannerResult,
      bundleAction: bundleAction || { action: "continue", reason: "generate_or_replay_missing_stage" },
      continuation: continuation || { decision: "continue", reason: "generate_or_replay_missing_stage" },
      bundle: workingBundle,
      voiceDeadlineMs,
      targetStageIndex: stageToGenerate,
      deps: services,
    });

    if (!generated?.ok || !generated?.stage || !generated?.payload) {
      return generated || {
        ok: false,
        reason: "stage_generation_failed",
        status: "error",
        bundle: workingBundle,
      };
    }

    workingBundle = generated.bundle || workingBundle;
    const producedIndex = Number(generated.stage.stageIndex || 0);
    if (normalizedTarget == null || producedIndex >= normalizedTarget) {
      return generated;
    }

    if (!generated.stage.moreAvailable) {
      return {
        ok: false,
        reason: "no_more_stages",
        status: "completed",
        bundle: workingBundle,
        requestedStageIndex: normalizedTarget,
        stage: generated.stage,
        payload: generated.payload,
      };
    }

    attempts += 1;
  }

  return {
    ok: false,
    reason: "stage_generation_exhausted",
    status: "error",
    bundle: workingBundle,
  };
}

async function maybeReplayStoredStage({
  username,
  bundle,
  stageIndex,
  question = "",
  requestId = null,
  deps = null,
} = {}) {
  const services = resolveOrchestratorDeps(deps);
  if (!bundle?.bundleId) {
    return {
      ok: false,
      reason: "missing_bundle",
      bundle: bundle || null,
      stage: null,
      payload: null,
      stageSummary: null,
    };
  }

  const replayResult = services.replayStoredStage({
    bundle,
    stageIndex,
    question,
    requestId,
    voiceAnswerSource: "gpt",
  });

  if (!replayResult?.ok || !replayResult?.stage || !replayResult?.payload) {
    return {
      ok: false,
      reason: replayResult?.reason || "replay_not_available",
      requestedStageIndex: replayResult?.stageIndex ?? stageIndex ?? null,
      bundle,
      stage: null,
      payload: null,
      stageSummary: null,
    };
  }

  const replayedStageIndex = Number(replayResult.stage.stageIndex || 0);
  const patchedBundle = await services.setBundleStageIndex(bundle.bundleId, replayedStageIndex);
  services.applyStageReplayState(username, {
    activeStageIndex: replayedStageIndex,
    requestedStageIndex: replayedStageIndex,
  });
  orchestratorLog("stored stage replay resolved", {
    username,
    bundleId: bundle.bundleId,
    stageIndex: replayedStageIndex,
  });

  return {
    ok: true,
    reason: "replayed_stored_stage",
    stageGenerator: "replay_stored_stage",
    bundle: patchedBundle || bundle,
    stage: replayResult.stage,
    payload: replayResult.payload,
    stageSummary: replayResult.stageSummary || extractStageSummary(replayResult.stage),
  };
}

async function handleStageReplay({
  username,
  bundleId = null,
  stageIndex = null,
  question = "",
  requestId = null,
  __deps = null,
} = {}) {
  const services = resolveOrchestratorDeps(__deps);
  const safeUsername = normalizeUsername(username);
  const safeQuestion = sanitizeQuestion(question);
  const safeRequestId = requestId || makeRequestKey(requestId);

  if (!services.isMongoReady()) {
    return {
      ok: false,
      status: "error",
      reason: "mongo_not_ready",
      voiceAnswer: "I could not load that stage right now.",
      payload: null,
      bundleId: null,
      stage: null,
    };
  }

  const sessionBundleId = services.getActiveBundleId(safeUsername);
  const lookupBundleId = bundleId || sessionBundleId || null;
  const bundle = lookupBundleId
    ? await services.getBundleById(lookupBundleId)
    : await services.loadActiveBundleForUser(safeUsername);

  if (!bundle?.bundleId) {
    return {
      ok: false,
      status: "error",
      reason: "bundle_not_found",
      voiceAnswer: "I do not have an active analysis to replay yet.",
      payload: null,
      bundleId: null,
      stage: null,
    };
  }

  services.setActiveBundleId(safeUsername, bundle.bundleId);
  const latestStage = services.getLatestStage(bundle);
  const maxStageIndex = Number(latestStage?.stageIndex || 0);
  const parsedRequested = parseStageIndexInput(stageIndex);
  const normalizedIndex = parsedRequested == null
    ? normalizeRequestedStageIndex(
        stageIndex == null ? bundle.currentStageIndex : stageIndex,
        maxStageIndex
      )
    : parsedRequested;
  services.setRequestedStageIndex(safeUsername, normalizedIndex);

  const replayed = await maybeReplayStoredStage({
    username: safeUsername,
    bundle,
    stageIndex: normalizedIndex,
    question: safeQuestion || bundle.question || "",
    requestId: safeRequestId,
    deps: services,
  });

  if (!replayed?.ok || !replayed.payload || !replayed.stage) {
    return {
      ok: false,
      status: "error",
      reason: replayed?.reason || "stage_not_found",
      voiceAnswer: "I could not find that stage yet.",
      payload: null,
      bundleId: bundle.bundleId,
      stage: null,
      requestedStageIndex: normalizedIndex,
    };
  }

  return {
    ...buildStageResultEnvelope({
      payload: replayed.payload,
      stageRecord: replayed.stage,
      stageSummary: replayed.stageSummary,
      plannerResult: toPlannerResultFromBundle(replayed.bundle),
      bundleId: replayed.bundle?.bundleId || bundle.bundleId,
      bundleAction: { action: "continue", reason: "stage_replay" },
      continuation: { decision: "continue", reason: "stage_replay" },
      userContext: null,
      stageGenerator: replayed.stageGenerator || "replay_stored_stage",
    }),
    ok: true,
    stage: replayed.stage,
    bundleId: replayed.bundle?.bundleId || bundle.bundleId,
  };
}

function resolveNavigationTargetStage({ action, stageIndex = null, bundle = null } = {}) {
  const normalizedAction = normalizeNavigationAction(action);
  const latestStage = getLatestStage(bundle);
  const maxStageIndex = Number(latestStage?.stageIndex || 0);
  const currentStageIndex = Number.isFinite(Number(bundle?.currentStageIndex))
    ? Math.max(0, Number(bundle.currentStageIndex))
    : maxStageIndex;
  const parsedRequestedIndex = parseStageIndexInput(stageIndex);

  if (normalizedAction === "stage_next") {
    return {
      action: normalizedAction,
      targetStageIndex: currentStageIndex + 1,
      maxStageIndex,
      currentStageIndex,
    };
  }
  if (normalizedAction === "stage_back") {
    return {
      action: normalizedAction,
      targetStageIndex: Math.max(0, currentStageIndex - 1),
      maxStageIndex,
      currentStageIndex,
    };
  }
  if (normalizedAction === "stage_replay") {
    return {
      action: normalizedAction,
      targetStageIndex: parsedRequestedIndex == null ? currentStageIndex : parsedRequestedIndex,
      maxStageIndex,
      currentStageIndex,
    };
  }
  if (normalizedAction === "stage_goto") {
    return {
      action: normalizedAction,
      targetStageIndex: parsedRequestedIndex == null ? currentStageIndex : parsedRequestedIndex,
      maxStageIndex,
      currentStageIndex,
    };
  }
  return {
    action: normalizedAction,
    targetStageIndex: parsedRequestedIndex == null ? currentStageIndex : parsedRequestedIndex,
    maxStageIndex,
    currentStageIndex,
  };
}

async function handleNavigationControl({
  username,
  action,
  stageIndex = null,
  bundleId = null,
  question = "",
  requestId = null,
  voiceDeadlineMs = 4200,
  userContext = null,
  __deps = null,
} = {}) {
  const services = resolveOrchestratorDeps(__deps);
  const safeUsername = normalizeUsername(username);
  const safeQuestion = sanitizeQuestion(question);
  const requestKey = makeRequestKey(requestId);
  const safeRequestId = requestId || requestKey;
  const requestSource = "followup";
  services.setLatestRequestKey(safeUsername, requestKey);

  const requestState = typeof services.beginRequest === "function"
    ? services.beginRequest({
        username: safeUsername,
        bundleId: bundleId || null,
        source: requestSource,
        requestKey,
      })
    : null;

  if (requestState?.concurrentDetected) {
    orchestratorWarn("concurrent navigation request detected", {
      username: safeUsername,
      requestKey,
      activeRequestCount: requestState.activeRequestCount || null,
    });
    if (typeof services.recordSessionAudit === "function") {
      services.recordSessionAudit({
        eventType: "concurrent_request_detected",
        username: safeUsername,
        bundleId: bundleId || null,
        requestKey,
        source: requestSource,
        reason: "navigation_request_overlap",
      });
    }
  }

  try {
    if (!services.isMongoReady()) {
      return {
        ok: false,
        status: "error",
        reason: "mongo_not_ready",
        voiceAnswer: "I could not load that stage right now.",
        payload: null,
      };
    }

    const sessionBundleId = services.getActiveBundleId(safeUsername);
    const lookupBundleId = bundleId || sessionBundleId || null;
    const bundle = lookupBundleId
      ? await services.getBundleById(lookupBundleId)
      : await services.loadActiveBundleForUser(safeUsername);

    if (!bundle?.bundleId) {
      return {
        ok: false,
        status: "error",
        reason: "bundle_not_found",
        voiceAnswer: "I do not have an active analysis yet. Ask a health question first.",
        payload: null,
      };
    }

    await bindRequestToBundle({
      services,
      username: safeUsername,
      requestKey,
      bundleId: bundle.bundleId,
      source: requestSource,
    });
    if (typeof services.setActiveBundleForUser === "function") {
      services.setActiveBundleForUser(safeUsername, bundle.bundleId);
    } else if (typeof services.setActiveBundleId === "function") {
      services.setActiveBundleId(safeUsername, bundle.bundleId);
    }
    const target = resolveNavigationTargetStage({
      action,
      stageIndex,
      bundle,
    });
    const allowGeneration = target.action === "stage_next" || target.action === "stage_goto";
    orchestratorLog("navigation target resolved", {
      username: safeUsername,
      requestKey,
      bundleId: bundle.bundleId,
      action: target.action,
      currentStageIndex: target.currentStageIndex,
      targetStageIndex: target.targetStageIndex,
      maxStageIndex: target.maxStageIndex,
      allowGeneration,
      previousResponseId: bundle.executorResponseId || null,
    });
    services.setRequestedStageIndex(safeUsername, target.targetStageIndex);

    const stageResult = await services.generateOrReplayStage({
      requestId: safeRequestId,
      requestKey,
      requestSource,
      username: safeUsername,
      question: safeQuestion || bundle.question || "show more",
      userContext,
      plannerResult: toPlannerResultFromBundle(bundle),
      bundleAction: { action: "continue", reason: "navigation_generation" },
      continuation: { decision: "continue", reason: "navigation_generation" },
      bundle,
      targetStageIndex: target.targetStageIndex,
      voiceDeadlineMs,
      preferReplay: true,
      allowGeneration,
      deps: services,
    });

    const requestStillCurrent = isCurrentRequestGuard(
      services,
      safeUsername,
      requestKey,
      stageResult?.bundle?.bundleId || bundle.bundleId
    );

    if (stageResult?.ok && stageResult.payload && stageResult.stage) {
      if (!requestStillCurrent && STRICT_STALE_RESULT_REJECTION) {
        orchestratorWarn("stale executor navigation result discarded", {
          username: safeUsername,
          requestKey,
          latestRequestKey: services.getSessionState(safeUsername)?.latestRequestKey || null,
          bundleId: stageResult.bundle?.bundleId || bundle.bundleId,
        });
        recordStaleDiscard(services, {
          username: safeUsername,
          bundleId: stageResult.bundle?.bundleId || bundle.bundleId,
          requestKey,
          source: requestSource,
          reason: "stale_navigation_executor_result",
          scope: "navigation",
        });
        return staleResultResponse({
          reason: "stale_navigation_executor_result",
          bundleId: stageResult.bundle?.bundleId || bundle.bundleId,
        });
      }
      services.applyStageReplayState(safeUsername, {
        activeStageIndex: stageResult.stage.stageIndex,
        requestedStageIndex: target.targetStageIndex,
      });
      const navStageGen = stageResult.stageGenerator || "executor_navigation";
      orchestratorLog("path=navigation stageGenerator=" + navStageGen + " bundleId=" + (stageResult.bundle?.bundleId || bundle.bundleId || "null") + " stageIndex=" + (stageResult.stage?.stageIndex ?? "null"), {
        username: safeUsername,
        requestKey,
        bundleId: stageResult.bundle?.bundleId || bundle.bundleId,
        action: target.action,
        stageIndex: stageResult.stage.stageIndex,
        stageGenerator: navStageGen,
        replayed: stageResult.stageGenerator === "replay_stored_stage",
      });
      return {
        ...buildStageResultEnvelope({
          payload: stageResult.payload,
          stageRecord: stageResult.stage,
          stageSummary: stageResult.stageSummary,
          plannerResult: toPlannerResultFromBundle(stageResult.bundle || bundle),
          bundleId: stageResult.bundle?.bundleId || bundle.bundleId,
          bundleAction: { action: "continue", reason: "navigation_generation" },
          continuation: { decision: "continue", reason: "navigation_generation" },
          userContext,
          stageGenerator: navStageGen,
        }),
        ok: true,
        stage: stageResult.stage,
        bundleId: stageResult.bundle?.bundleId || bundle.bundleId,
      };
    }

    if (stageResult?.stale && STRICT_STALE_RESULT_REJECTION) {
      recordStaleDiscard(services, {
        username: safeUsername,
        bundleId: stageResult?.bundle?.bundleId || bundle.bundleId,
        requestKey,
        source: requestSource,
        reason: stageResult.reason || "stale_navigation_result",
        scope: "navigation",
      });
      return staleResultResponse({
        reason: stageResult.reason || "stale_navigation_result",
        bundleId: stageResult?.bundle?.bundleId || bundle.bundleId,
      });
    }

    if (isTerminalStageReason(stageResult?.reason)) {
      const terminalBundle = stageResult?.bundle || bundle;
      const terminal = buildTerminalStageResult({
        reason: stageResult?.reason || "stage_sequence_complete",
        bundle: terminalBundle,
        requestId: safeRequestId,
        question: safeQuestion || terminalBundle.question || "",
        voiceAnswerSource: "gpt",
      });
      return {
        ...terminal,
        stage: stageResult?.stage || getLatestStage(terminalBundle),
        orchestrator: {
          used: true,
          bundleId: terminalBundle.bundleId,
          bundleAction: "continue",
          continuationDecision: "continue",
          plannerMode: toPlannerResultFromBundle(terminalBundle)?.mode || null,
          stageGenerator: "stage_limit_reached",
          fallbackReason: stageResult?.reason || "stage_sequence_complete",
        },
      };
    }

    const shouldUseLegacyFallback = EXECUTOR_ALLOW_NAV_FALLBACK
      && allowGeneration
      && !isTerminalStageReason(stageResult?.reason);
    if (!shouldUseLegacyFallback) {
      const replayUnavailable = !allowGeneration;
      orchestratorWarn("navigation stage unavailable without legacy fallback", {
        username: safeUsername,
        requestKey,
        bundleId: bundle.bundleId,
        action: target.action,
        reason: stageResult?.reason || "navigation_stage_generation_failed",
        allowGeneration,
      });
      return {
        ok: false,
        status: "error",
        reason: stageResult?.reason || "navigation_stage_generation_failed",
        voiceAnswer: replayUnavailable
          ? "I do not have that saved stage yet."
          : "I could not move to that stage yet.",
        payload: null,
        bundleId: bundle.bundleId,
      };
    }

    // Preserve safety net: fallback still routes through legacy qnaEngine.
    const legacyResult = await services.runLegacyStage1({
      requestId: safeRequestId,
      username: safeUsername,
      question: safeQuestion || bundle.question || "show more",
      userContext,
      voiceDeadlineMs,
      allowFetchPlannerLLM: true,
      allowPresenterLLM: true,
      enableVisualContinuation: true,
    });
    if (!isCurrentRequestGuard(services, safeUsername, requestKey, bundle.bundleId) && STRICT_STALE_RESULT_REJECTION) {
      recordStaleDiscard(services, {
        username: safeUsername,
        bundleId: bundle.bundleId,
        requestKey,
        source: requestSource,
        reason: "stale_navigation_fallback_result",
        scope: "navigation",
      });
      return staleResultResponse({
        reason: "stale_navigation_fallback_result",
        bundleId: bundle.bundleId,
      });
    }
    const fallbackStage = services.buildLegacyFallbackStage({
      legacyResult,
      payload: legacyResult?.payload,
      plannerResult: toPlannerResultFromBundle(bundle),
      stageIndex: Math.max(0, target.targetStageIndex),
      requestId: safeRequestId,
      question: safeQuestion || bundle.question || "",
    });
    const persistedFallback = await services.persistStageResult({
      bundle,
      stageRecord: fallbackStage,
      executorResponseId: bundle.executorResponseId || null,
      statusReason: "navigation_legacy_fallback_stage_persisted",
      requestKey,
      rejectStaleRequest: true,
    });

    if (!persistedFallback?.stageRecord || !legacyResult?.payload) {
      return {
        ok: false,
        status: "error",
        reason: stageResult?.reason || "navigation_stage_generation_failed",
        voiceAnswer: "I could not load that stage right now.",
        payload: null,
        bundleId: bundle.bundleId,
      };
    }

    services.applyStageReplayState(safeUsername, {
      activeStageIndex: persistedFallback.stageRecord.stageIndex,
      requestedStageIndex: target.targetStageIndex,
    });
    orchestratorWarn("path=navigation stageGenerator=legacy_navigation_fallback bundleId=" + (persistedFallback.bundle?.bundleId || bundle.bundleId || "null") + " stageIndex=" + (persistedFallback.stageRecord?.stageIndex ?? "null") + " fallbackReason=" + (stageResult?.reason || "executor_navigation_unavailable"), {
      username: safeUsername,
      requestKey,
      bundleId: persistedFallback.bundle?.bundleId || bundle.bundleId,
      action: target.action,
      targetStageIndex: target.targetStageIndex,
      persistedStageIndex: persistedFallback.stageRecord.stageIndex,
      fallbackReason: stageResult?.reason || "executor_navigation_unavailable",
      previousResponseId: bundle.executorResponseId || null,
    });

    return {
      ...legacyResult,
      ok: true,
      stage: persistedFallback.stageRecord,
      bundleId: persistedFallback.bundle?.bundleId || bundle.bundleId,
      orchestrator: {
        used: true,
        bundleId: persistedFallback.bundle?.bundleId || bundle.bundleId,
        bundleAction: "continue",
        continuationDecision: "continue",
        plannerMode: toPlannerResultFromBundle(bundle)?.mode || null,
        stageSummary: persistedFallback.stageSummary || null,
        stageGenerator: "legacy_navigation_fallback",
        fallbackReason: stageResult?.reason || "executor_navigation_unavailable",
      },
    };
  } finally {
    if (typeof services.endRequest === "function") {
      services.endRequest({
        username: safeUsername,
        requestKey,
        bundleId: bundleId || null,
        status: "navigation_complete",
      });
    }
  }
}

async function handleQuestionWithOrchestrator({
  requestId = null,
  username,
  question,
  sessionHints = null,
  userContext = null,
  voiceDeadlineMs = 4200,
  allowFetchPlannerLLM = true,
  allowPresenterLLM = true,
  enableVisualContinuation = true,
  fetchPlanTimeoutMs,
  fetchTimeoutMs = null,
  __deps = null,
} = {}) {
  const services = resolveOrchestratorDeps(__deps);
  const safeUsername = normalizeUsername(username);
  const safeSessionHints = sanitizeSessionHints(sessionHints);
  const safeQuestion = sanitizeQuestion(question || safeSessionHints?.lastQuestion || "");
  const requestKey = makeRequestKey(requestId);
  const safeRequestId = requestId || requestKey;
  const requestSource = "alexa";
  services.setLatestRequestKey(safeUsername, requestKey);
  applySessionHintsToRequest({
    services,
    username: safeUsername,
    sessionHints: safeSessionHints,
    requestKey,
  });

  const requestState = typeof services.beginRequest === "function"
    ? services.beginRequest({
        username: safeUsername,
        source: requestSource,
        requestKey,
      })
    : null;

  if (requestState?.concurrentDetected) {
    orchestratorWarn("concurrent question request detected", {
      username: safeUsername,
      requestKey,
      activeRequestCount: requestState.activeRequestCount || null,
    });
    if (typeof services.recordSessionAudit === "function") {
      services.recordSessionAudit({
        eventType: "concurrent_request_detected",
        username: safeUsername,
        requestKey,
        source: requestSource,
        reason: "question_request_overlap",
      });
    }
  }

  let activeBundle = null;
  let plannerResult = null;
  let continuation = null;
  let bundleAction = null;
  let resolvedBundle = null;
  let executorFailureReason = null;

  try {
    if (!ORCHESTRATOR_PRIMARY_ENABLED) {
      orchestratorWarn("path=legacy_fallback reason=orchestrator_disabled", { username: safeUsername });
      const legacyResult = await services.runLegacyStage1({
        requestId: safeRequestId,
        username: safeUsername,
        question: safeQuestion,
        userContext,
        voiceDeadlineMs,
        allowFetchPlannerLLM,
        allowPresenterLLM,
        enableVisualContinuation,
        fetchPlanTimeoutMs,
        fetchTimeoutMs,
      });
      return {
        ...legacyResult,
        orchestrator: {
          used: false,
          fallbackReason: "orchestrator_disabled",
        },
      };
    }

    if (!services.isMongoReady()) {
      orchestratorWarn("path=legacy_fallback reason=mongo_not_ready", { username: safeUsername });
      const legacyResult = await services.runLegacyStage1({
        requestId: safeRequestId,
        username: safeUsername,
        question: safeQuestion,
        userContext,
        voiceDeadlineMs,
        allowFetchPlannerLLM,
        allowPresenterLLM,
        enableVisualContinuation,
        fetchPlanTimeoutMs,
        fetchTimeoutMs,
      });
      return {
        ...legacyResult,
        orchestrator: {
          used: false,
          fallbackReason: "mongo_not_ready",
        },
      };
    }

    const resolvedUserContext = userContext || await services.getUserContext(safeUsername) || null;
    activeBundle = await services.loadActiveBundleForUser(safeUsername);

    plannerResult = await services.planQuestion({
      question: safeQuestion,
      username: safeUsername,
      activeBundle,
      userContext: resolvedUserContext,
    });
    orchestratorLog("path=planner_used bundleId=" + (activeBundle?.bundleId || "null") + " plannerMode=" + (plannerResult?.mode || "null"), {
      username: safeUsername,
      requestKey,
      activeBundleId: activeBundle?.bundleId || null,
      plannerMode: plannerResult?.mode || null,
      metricsNeeded: plannerResult?.metricsNeeded || [],
      timeScope: plannerResult?.timeScope || null,
      analysisGoal: plannerResult?.analysisGoal || null,
      candidateStageTypes: plannerResult?.candidateStageTypes || [],
      previousResponseId: activeBundle?.executorResponseId || null,
    });

    continuation = services.classifyContinuation({
      question: safeQuestion,
      activeBundleSummary: buildActiveBundleSummary(activeBundle),
      plannerResult,
    });

    bundleAction = resolveBundleAction({
      activeBundle,
      plannerResult,
      continuationDecision: continuation.decision,
    });
    orchestratorLog("bundle action resolved", {
      username: safeUsername,
      requestKey,
      activeBundleId: activeBundle?.bundleId || null,
      bundleAction: bundleAction?.action || null,
      bundleReason: bundleAction?.reason || null,
      continuationDecision: continuation?.decision || null,
      continuationReason: continuation?.reason || null,
    });

    if (bundleAction.action === "continue") {
      resolvedBundle = await services.continueExistingBundle({ activeBundle, plannerResult });
    } else if (bundleAction.action === "branch") {
      resolvedBundle = await services.branchBundle({
        activeBundle,
        username: safeUsername,
        question: safeQuestion,
        plannerResult,
        requestKey,
        requestSource,
      });
    } else {
      resolvedBundle = await services.startNewBundleFromPlanner({
        username: safeUsername,
        question: safeQuestion,
        plannerResult,
        activeBundle,
        reason: bundleAction.reason,
        requestKey,
        requestSource,
      });
    }

    if (resolvedBundle?.bundleId) {
      await bindRequestToBundle({
        services,
        username: safeUsername,
        requestKey,
        bundleId: resolvedBundle.bundleId,
        source: requestSource,
      });
      if (typeof services.setActiveBundleForUser === "function") {
        services.setActiveBundleForUser(safeUsername, resolvedBundle.bundleId);
      } else if (typeof services.setActiveBundleId === "function") {
        services.setActiveBundleId(safeUsername, resolvedBundle.bundleId);
      }
      resolvedBundle = await services.ensureBundleHasNormalizedData({
        bundle: resolvedBundle,
        username: safeUsername,
        question: safeQuestion,
        plannerResult,
        fetchTimeoutMs: fetchTimeoutMs || BUNDLE_DATA_FETCH_TIMEOUT_MS,
      });
      orchestratorLog("bundle ready for executor", {
        username: safeUsername,
        requestKey,
        bundleId: resolvedBundle?.bundleId || null,
        stageCount: Array.isArray(resolvedBundle?.stages) ? resolvedBundle.stages.length : 0,
        currentStageIndex: Number(resolvedBundle?.currentStageIndex || 0),
        normalizedRows: Array.isArray(resolvedBundle?.normalizedTable) ? resolvedBundle.normalizedTable.length : 0,
        previousResponseId: resolvedBundle?.executorResponseId || null,
      });
    }

    if (!isCurrentRequestGuard(services, safeUsername, requestKey, resolvedBundle?.bundleId || null) && STRICT_STALE_RESULT_REJECTION) {
      recordStaleDiscard(services, {
        username: safeUsername,
        bundleId: resolvedBundle?.bundleId || null,
        requestKey,
        source: requestSource,
        reason: "stale_pre_generation",
        scope: "question",
      });
      return staleResultResponse({
        reason: "stale_pre_generation",
        bundleId: resolvedBundle?.bundleId || null,
      });
    }

    const hasExistingStages = Array.isArray(resolvedBundle?.stages) && resolvedBundle.stages.length > 0;
    const shouldAdvanceStage = hasExistingStages
      && bundleAction?.action === "continue"
      && String(continuation?.decision || "").toLowerCase() === "continue"
      && services.shouldGenerateNextStage(bundleAction, continuation, resolvedBundle);
    const targetStageIndex = shouldAdvanceStage ? services.getNextStageIndex(resolvedBundle) : 0;
    orchestratorLog("executor stage request", {
      username: safeUsername,
      requestKey,
      bundleId: resolvedBundle?.bundleId || null,
      targetStageIndex,
      shouldAdvanceStage,
      stageCount: Array.isArray(resolvedBundle?.stages) ? resolvedBundle.stages.length : 0,
      previousResponseId: resolvedBundle?.executorResponseId || null,
    });
    const stageResult = await services.generateOrReplayStage({
      requestId: safeRequestId,
      requestKey,
      requestSource,
      username: safeUsername,
      question: safeQuestion,
      userContext: resolvedUserContext,
      plannerResult,
      bundleAction,
      continuation,
      bundle: resolvedBundle,
      targetStageIndex,
      voiceDeadlineMs,
      preferReplay: true,
      deps: services,
    });

    if (stageResult?.ok && stageResult?.payload && stageResult?.stage) {
      if (!isCurrentRequestGuard(services, safeUsername, requestKey, stageResult.bundle?.bundleId || resolvedBundle?.bundleId || null)
        && STRICT_STALE_RESULT_REJECTION) {
        orchestratorWarn("stale executor result discarded", {
          username: safeUsername,
          requestKey,
          latestRequestKey: services.getSessionState(safeUsername)?.latestRequestKey || null,
          bundleId: stageResult.bundle?.bundleId || resolvedBundle?.bundleId || null,
        });
        recordStaleDiscard(services, {
          username: safeUsername,
          bundleId: stageResult.bundle?.bundleId || resolvedBundle?.bundleId || null,
          requestKey,
          source: requestSource,
          reason: "stale_executor_result",
          scope: "question",
        });
        return staleResultResponse({
          reason: "stale_executor_result",
          bundleId: stageResult.bundle?.bundleId || resolvedBundle?.bundleId || null,
        });
      }

      services.setSessionStageIndex(safeUsername, stageResult.stage.stageIndex);
      const execBundleId = stageResult.bundle?.bundleId || resolvedBundle?.bundleId || null;
      const execPrevId = stageResult.bundle?.executorResponseId || resolvedBundle?.executorResponseId || null;
      orchestratorLog("path=executor_primary bundleId=" + (execBundleId || "null") + " stageIndex=" + (stageResult.stage.stageIndex ?? "null") + " previous_response_id=" + (execPrevId || "null"), {
        username: safeUsername,
        requestKey,
        bundleId: execBundleId,
        stageIndex: stageResult.stage.stageIndex,
        stageGenerator: stageResult.stageGenerator || "executor_primary",
        moreAvailable: Boolean(stageResult.stage.moreAvailable),
        previousResponseId: execPrevId,
      });
      return buildStageResultEnvelope({
        payload: stageResult.payload,
        stageRecord: stageResult.stage,
        stageSummary: stageResult.stageSummary,
        plannerResult,
        bundleId: stageResult.bundle?.bundleId || resolvedBundle?.bundleId || null,
        bundleAction,
        continuation,
        userContext: resolvedUserContext,
        stageGenerator: stageResult.stageGenerator || "executor_primary",
      });
    }

    if (stageResult?.stale && STRICT_STALE_RESULT_REJECTION) {
      recordStaleDiscard(services, {
        username: safeUsername,
        bundleId: stageResult?.bundle?.bundleId || resolvedBundle?.bundleId || null,
        requestKey,
        source: requestSource,
        reason: stageResult.reason || "stale_executor_generation",
        scope: "question",
      });
      return staleResultResponse({
        reason: stageResult.reason || "stale_executor_generation",
        bundleId: stageResult?.bundle?.bundleId || resolvedBundle?.bundleId || null,
      });
    }

    if (isTerminalStageReason(stageResult?.reason)) {
      const terminalBundle = stageResult?.bundle || resolvedBundle;
      const terminal = buildTerminalStageResult({
        reason: stageResult?.reason || "stage_sequence_complete",
        bundle: terminalBundle,
        requestId: safeRequestId,
        question: safeQuestion,
        voiceAnswerSource: "gpt",
      });
      return {
        ...terminal,
        plannerResult,
        orchestrator: {
          used: true,
          bundleId: terminalBundle?.bundleId || null,
          bundleAction: bundleAction?.action || null,
          continuationDecision: continuation?.decision || null,
          plannerMode: plannerResult?.mode || null,
          stageGenerator: "stage_limit_reached",
          fallbackReason: stageResult?.reason || "stage_sequence_complete",
        },
      };
    }

    executorFailureReason = stageResult?.reason || "executor_not_available";
    orchestratorWarn("path=legacy_fallback reason=" + (executorFailureReason || "executor_failed") + " bundleId=" + (resolvedBundle?.bundleId || "null") + " previous_response_id=" + (resolvedBundle?.executorResponseId || "null") + " stageIndex=" + (targetStageIndex ?? "null"), {
      username: safeUsername,
      bundleId: resolvedBundle?.bundleId || null,
      reason: executorFailureReason,
      status: stageResult?.status || null,
    });

    if (!EXECUTOR_ALLOW_STAGE1_FALLBACK) {
      return {
        ok: false,
        status: "error",
        reason: executorFailureReason,
        voiceAnswer: "I could not complete that request right now.",
        payload: null,
        bundleId: resolvedBundle?.bundleId || null,
      };
    }

    const legacyResult = await services.runLegacyStage1({
      requestId: safeRequestId,
      username: safeUsername,
      question: safeQuestion,
      userContext: resolvedUserContext,
      voiceDeadlineMs,
      allowFetchPlannerLLM,
      allowPresenterLLM,
      enableVisualContinuation,
      fetchPlanTimeoutMs,
      fetchTimeoutMs,
    });

    if (!isCurrentRequestGuard(services, safeUsername, requestKey, resolvedBundle?.bundleId || null) && STRICT_STALE_RESULT_REJECTION) {
      orchestratorWarn("stale legacy fallback result discarded", {
        username: safeUsername,
        requestKey,
        latestRequestKey: services.getSessionState(safeUsername)?.latestRequestKey || null,
        bundleId: resolvedBundle?.bundleId || null,
      });
      recordStaleDiscard(services, {
        username: safeUsername,
        bundleId: resolvedBundle?.bundleId || null,
        requestKey,
        source: requestSource,
        reason: "stale_legacy_fallback_result",
        scope: "question",
      });
      return staleResultResponse({
        reason: "stale_legacy_fallback_result",
        bundleId: resolvedBundle?.bundleId || null,
      });
    }

    const legacyStageIndex = targetStageIndex;
    const stageRecord = services.buildLegacyFallbackStage({
      legacyResult,
      payload: legacyResult?.payload,
      plannerResult,
      stageIndex: legacyStageIndex,
      requestId: safeRequestId,
      question: safeQuestion,
    });

    const persisted = await services.persistStageResult({
      bundle: resolvedBundle,
      stageRecord,
      executorResponseId: resolvedBundle?.executorResponseId || null,
      statusReason: "legacy_fallback_stage_persisted",
      requestKey,
      rejectStaleRequest: true,
    });

    if (persisted?.stageRecord) {
      services.setSessionStageIndex(safeUsername, persisted.stageRecord.stageIndex);
      orchestratorWarn("path=legacy_fallback legacy fallback stage persisted", {
        username: safeUsername,
        requestKey,
        bundleId: resolvedBundle?.bundleId || null,
        stageIndex: persisted.stageRecord.stageIndex,
        fallbackReason: executorFailureReason,
        previousResponseId: resolvedBundle?.executorResponseId || null,
      });
    }

    return {
      ...legacyResult,
      plannerResult,
      bundleId: resolvedBundle?.bundleId || null,
      stage: persisted?.stageRecord || null,
      orchestrator: {
        used: true,
        bundleId: resolvedBundle?.bundleId || null,
        bundleAction: bundleAction.action,
        continuationDecision: continuation.decision,
        plannerMode: plannerResult?.mode || null,
        stageSummary: persisted?.stageSummary || null,
        stageGenerator: "legacy_fallback",
        fallbackReason: executorFailureReason,
      },
    };
  } catch (error) {
    orchestratorError("handleQuestionWithOrchestrator failed, using legacy fallback", error);
    try {
      if (resolvedBundle?.bundleId) {
        await services.setBundleStatus(
          resolvedBundle.bundleId,
          "failed",
          {},
          "orchestrator_error",
          {
            requestKey,
            rejectStaleRequest: false,
          }
        );
      }
    } catch (statusErr) {
      orchestratorWarn("failed to set bundle status after orchestrator error", {
        bundleId: resolvedBundle?.bundleId || null,
        message: statusErr?.message || String(statusErr),
      });
    }

    const legacyResult = await services.runLegacyStage1({
      requestId: safeRequestId,
      username: safeUsername,
      question: safeQuestion,
      userContext,
      voiceDeadlineMs,
      allowFetchPlannerLLM,
      allowPresenterLLM,
      enableVisualContinuation,
      fetchPlanTimeoutMs,
      fetchTimeoutMs,
    });

    return {
      ...legacyResult,
      plannerResult,
      bundleId: resolvedBundle?.bundleId || null,
      orchestrator: {
        used: false,
        fallbackReason: "orchestrator_error",
        bundleId: resolvedBundle?.bundleId || null,
      },
    };
  } finally {
    if (typeof services.endRequest === "function") {
      services.endRequest({
        username: safeUsername,
        requestKey,
        bundleId: resolvedBundle?.bundleId || null,
        status: "question_complete",
      });
    }
  }
}

async function handleFollowupWithOrchestrator({
  requestId = null,
  username,
  question,
  bundleId = null,
  sessionHints = null,
  userContext = null,
  voiceDeadlineMs = 4200,
  allowFetchPlannerLLM = true,
  allowPresenterLLM = true,
  enableVisualContinuation = true,
  fetchPlanTimeoutMs,
  fetchTimeoutMs = null,
  __deps = null,
} = {}) {
  const services = resolveOrchestratorDeps(__deps);
  const safeUsername = normalizeUsername(username);
  const safeSessionHints = sanitizeSessionHints(sessionHints);
  const safeQuestion = sanitizeQuestion(question || safeSessionHints?.lastQuestion || "");
  const safeBundleId = bundleId ? String(bundleId) : null;
  const requestKey = makeRequestKey(requestId);
  applySessionHintsToRequest({
    services,
    username: safeUsername,
    sessionHints: safeSessionHints,
    requestKey,
  });

  const activeBundle = safeBundleId
    ? await services.getBundleById(safeBundleId)
    : await services.loadActiveBundleForUser(safeUsername);

  // If the active bundle is completed/released and has no more stages, treat
  // "show more" as a terminal dead-end rather than looping into planner.
  const bundleIsDone = ["completed", "released"].includes(String(activeBundle?.status || "").toLowerCase());
  if (bundleIsDone && activeBundle?.bundleId) {
    const latestStageDone = Array.isArray(activeBundle.stages) && activeBundle.stages.length > 0
      && activeBundle.stages.every((s) => !s.moreAvailable);
    const q = String(safeQuestion || "").toLowerCase();
    const isShowMore = /\b(show more|next|yes|yeah|sure|ok|okay|continue|go on|tell me more)\b/.test(q)
      || /^(yes|yeah|sure|ok|okay)$/.test(q);
    if (latestStageDone && isShowMore) {
      orchestratorLog("followup on completed bundle with no more stages — returning terminal", {
        username: safeUsername,
        bundleId: activeBundle.bundleId,
        bundleStatus: activeBundle.status,
      });
      const terminal = buildTerminalStageResult({
        reason: "no_more_stages",
        bundle: activeBundle,
        requestId: requestId || makeRequestKey(requestId),
        question: safeQuestion,
        voiceAnswerSource: "gpt",
      });
      return {
        ...terminal,
        ok: true,
        orchestrator: {
          used: true,
          bundleId: activeBundle.bundleId,
          stageGenerator: "completed_bundle_terminal",
          fallbackReason: "bundle_already_completed",
        },
      };
    }
  }

  const followupIntent = services.analyzeFollowupIntent({
    question: safeQuestion,
    activeBundleSummary: buildActiveBundleSummary(activeBundle),
    plannerResult: toPlannerResultFromBundle(activeBundle),
  });

  const normalizedFollowupQuestion = followupIntent?.normalizedQuestion || safeQuestion;

  if (followupIntent?.intentType === "control_navigation" && followupIntent?.action) {
    const controlResult = await handleControlWithOrchestrator({
      requestId,
      username: safeUsername,
      action: followupIntent.action,
      stageIndex: followupIntent.targetStageIndex,
      bundleId: safeBundleId || activeBundle?.bundleId || null,
      question: normalizedFollowupQuestion,
      voiceDeadlineMs,
      userContext,
      __deps: services,
    });
    if (controlResult?.orchestrator) {
      controlResult.orchestrator.followupDecision = followupIntent.decision || "continue";
      controlResult.orchestrator.followupReason = followupIntent.reason || null;
      controlResult.orchestrator.followupAction = followupIntent.action;
      controlResult.orchestrator.followupIntentType = followupIntent.intentType || "control_navigation";
      controlResult.orchestrator.followupRequiresGeneration = followupIntent.requiresGeneration === true;
    }
    return controlResult;
  }

  const result = await handleQuestionWithOrchestrator({
    requestId,
    username: safeUsername,
    question: normalizedFollowupQuestion,
    sessionHints: safeSessionHints,
    userContext,
    voiceDeadlineMs,
    allowFetchPlannerLLM,
    allowPresenterLLM,
    enableVisualContinuation,
    fetchPlanTimeoutMs,
    fetchTimeoutMs,
    __deps: services,
  });
  if (result?.orchestrator) {
    result.orchestrator.followupDecision = followupIntent?.decision || null;
    result.orchestrator.followupReason = followupIntent?.reason || null;
    result.orchestrator.followupAction = followupIntent?.action || null;
    result.orchestrator.followupIntentType = followupIntent?.intentType || null;
    result.orchestrator.followupBundleAction = followupIntent?.bundleAction || null;
  }
  return result;
}

async function handleControlWithOrchestrator({
  requestId = null,
  username,
  action,
  stageIndex = null,
  bundleId = null,
  question = "",
  sessionHints = null,
  userContext = null,
  voiceDeadlineMs = 4200,
  __deps = null,
} = {}) {
  const services = resolveOrchestratorDeps(__deps);
  const safeUsername = normalizeUsername(username);
  const safeAction = normalizeControlAction(action);
  const safeSessionHints = sanitizeSessionHints(sessionHints);
  const safeStageIndex = parseStageIndexInput(
    stageIndex == null ? safeSessionHints?.activeStageIndex : stageIndex
  );
  const safeQuestion = resolveControlQuestion({
    action: safeAction,
    question,
    sessionHints: safeSessionHints,
  });
  const requestKey = makeRequestKey(requestId);

  applySessionHintsToRequest({
    services,
    username: safeUsername,
    sessionHints: safeSessionHints,
    requestKey,
  });
  orchestratorLog("control action received", {
    username: safeUsername,
    requestKey,
    action: safeAction,
    stageIndex: safeStageIndex,
    bundleId: bundleId || null,
    questionPreview: sanitizeText(safeQuestion, 120, ""),
  });

  const navigationAction = (() => {
    if (safeAction === "show_more") return "show_more";
    if (safeAction === "back") return "back";
    if (safeAction === "replay") return "replay";
    if (safeAction === "goto_stage") return "goto_stage";
    return null;
  })();

  if (navigationAction) {
    return handleNavigationControl({
      requestId,
      username: safeUsername,
      action: navigationAction,
      stageIndex: safeStageIndex,
      bundleId: bundleId || null,
      question: safeQuestion,
      voiceDeadlineMs,
      userContext,
      __deps: services,
    });
  }

  if (safeAction === "start_over") {
    const restarted = await handleQuestionWithOrchestrator({
      requestId,
      username: safeUsername,
      question: safeQuestion || "start over",
      sessionHints: safeSessionHints,
      userContext,
      voiceDeadlineMs,
      __deps: services,
    });
    if (restarted?.orchestrator) restarted.orchestrator.controlAction = "start_over";
    return {
      ...restarted,
      ok: Boolean(restarted?.payload),
    };
  }

  if (safeAction === "compare" || safeAction === "explain" || safeAction === "summarize") {
    const replay = await handleStageReplay({
      requestId,
      username: safeUsername,
      bundleId: bundleId || null,
      stageIndex: safeStageIndex,
      question: safeQuestion,
      __deps: services,
    });

    if (!replay?.payload) {
      return {
        ok: false,
        status: "error",
        reason: replay?.reason || "stage_context_not_found",
        voiceAnswer: replay?.voiceAnswer || "I do not have enough chart context yet.",
        payload: replay?.payload || null,
        bundleId: replay?.bundleId || null,
        stage: replay?.stage || null,
        orchestrator: {
          used: true,
          bundleId: replay?.bundleId || null,
          stageGenerator: "stage_context_unavailable",
          fallbackReason: replay?.reason || "stage_context_not_found",
          controlAction: safeAction,
        },
      };
    }

    const actionQuestion = buildControlActionQuestion({
      action: safeAction,
      stage: replay.stage,
      fallbackQuestion: safeQuestion,
    });

    orchestratorLog("control action routed through planner/executor", {
      username: safeUsername,
      requestKey,
      action: safeAction,
      bundleId: replay?.bundleId || null,
      stageIndex: replay?.stage?.stageIndex ?? null,
      questionPreview: sanitizeText(actionQuestion, 180, ""),
    });

    const stageDriven = await handleQuestionWithOrchestrator({
      requestId,
      username: safeUsername,
      question: actionQuestion,
      sessionHints: {
        ...(safeSessionHints || {}),
        activeStageIndex: replay?.stage?.stageIndex ?? safeStageIndex,
        stageCount: Number(replay?.payload?.stageCount || safeSessionHints?.stageCount || 1),
        pendingAction: safeAction,
        lastQuestion: actionQuestion,
      },
      userContext,
      voiceDeadlineMs,
      __deps: services,
    });

    if (stageDriven?.stale) {
      if (stageDriven?.orchestrator) stageDriven.orchestrator.controlAction = safeAction;
      return {
        ...stageDriven,
        ok: false,
      };
    }

    if (stageDriven?.payload) {
      if (stageDriven?.orchestrator) {
        stageDriven.orchestrator.controlAction = safeAction;
        stageDriven.orchestrator.stageReplayUsed = true;
        stageDriven.orchestrator.referencedStageIndex = replay?.stage?.stageIndex ?? null;
      }
      return {
        ...stageDriven,
        ok: true,
      };
    }

    orchestratorWarn("control action stage generation unavailable, replaying stored stage", {
      username: safeUsername,
      requestKey,
      action: safeAction,
      bundleId: replay?.bundleId || null,
      stageIndex: replay?.stage?.stageIndex ?? null,
      reason: stageDriven?.reason || "control_stage_generation_unavailable",
    });

    return {
      ok: true,
      status: "complete",
      answerReady: Boolean(replay?.payload?.answer_ready),
      voiceAnswerSource: replay?.payload?.voice_answer_source || "gpt",
      voiceAnswer: replay?.payload?.voice_answer || replay?.payload?.spoken_answer || replay?.stage?.spokenText || "",
      payload: replay?.payload || null,
      bundleId: replay?.bundleId || null,
      stage: replay?.stage || null,
      orchestrator: {
        used: true,
        bundleId: replay?.bundleId || null,
        bundleAction: "continue",
        continuationDecision: "continue",
        plannerMode: replay?.plannerResult?.mode || null,
        stageSummary: replay?.orchestrator?.stageSummary || null,
        stageGenerator: "replay_stored_stage",
        fallbackReason: stageDriven?.reason || "control_stage_generation_unavailable",
        controlAction: safeAction,
      },
    };
  }

  return {
    ok: false,
    status: "error",
    reason: "unsupported_control_action",
    voiceAnswer: "I could not process that control request yet.",
    payload: null,
    bundleId: bundleId || null,
    stage: null,
    orchestrator: {
      used: true,
      bundleId: bundleId || null,
      stageGenerator: "unsupported_control_action",
      fallbackReason: "unsupported_control_action",
      controlAction: safeAction,
    },
  };
}

/**
 * Backward-compatible shadow-mode entry.
 */
async function runPlannerShadow({ username, question, activeBundle = null, userContext = null, __deps = null } = {}) {
  const services = resolveOrchestratorDeps(__deps);
  const safeUsername = normalizeUsername(username);
  const safeQuestion = sanitizeQuestion(question);

  if (!SHADOW_MODE_ENABLED) {
    return { ok: false, skipped: true, reason: "shadow_disabled" };
  }
  if (!safeUsername || !safeQuestion) {
    return { ok: false, skipped: true, reason: "missing_input" };
  }
  if (!services.isMongoReady()) {
    return { ok: false, skipped: true, reason: "mongo_not_ready" };
  }

  const loadedActiveBundle = activeBundle || await services.loadActiveBundleForUser(safeUsername);
  const plannerResult = await services.planQuestion({
    question: safeQuestion,
    username: safeUsername,
    activeBundle: loadedActiveBundle,
    userContext,
  });
  const continuation = services.classifyContinuation({
    question: safeQuestion,
    activeBundleSummary: buildActiveBundleSummary(loadedActiveBundle),
    plannerResult,
  });
  const bundleAction = resolveBundleAction({
    activeBundle: loadedActiveBundle,
    plannerResult,
    continuationDecision: continuation.decision,
  });

  let resolvedBundle = null;
  if (bundleAction.action === "continue") {
    resolvedBundle = await services.continueExistingBundle({
      activeBundle: loadedActiveBundle,
      plannerResult,
    });
  } else if (bundleAction.action === "branch") {
    resolvedBundle = await services.branchBundle({
      activeBundle: loadedActiveBundle,
      username: safeUsername,
      question: safeQuestion,
      plannerResult,
    });
  } else {
    resolvedBundle = await services.startNewBundleFromPlanner({
      username: safeUsername,
      question: safeQuestion,
      plannerResult,
      activeBundle: loadedActiveBundle,
      reason: "shadow_new_analysis",
    });
  }

  if (resolvedBundle?.bundleId) {
    if (typeof services.setActiveBundleForUser === "function") {
      services.setActiveBundleForUser(safeUsername, resolvedBundle.bundleId);
    } else if (typeof services.setActiveBundleId === "function") {
      services.setActiveBundleId(safeUsername, resolvedBundle.bundleId);
    }
  }

  return {
    ok: Boolean(resolvedBundle),
    action: bundleAction.action,
    bundleId: resolvedBundle?.bundleId || null,
    previousBundleId: loadedActiveBundle?.bundleId || null,
    continuationDecision: continuation.decision,
    plannerResult,
  };
}

module.exports = {
  applyStageProgressionPolicy,
  applySessionHintsToRequest,
  buildActiveBundleSummary,
  branchBundle,
  continueExistingBundle,
  finalizeBundleIfDone,
  generateNextMissingStage,
  generateOrReplayStage,
  handleControlWithOrchestrator,
  handleFollowupWithOrchestrator,
  handleNavigationControl,
  handleQuestionWithOrchestrator,
  handleStageReplay,
  maybeReplayStoredStage,
  persistStageResult,
  resolveBundleAction,
  runPlannerShadow,
  startNewBundleFromPlanner,
  storePlannerResultInBundle,
};
