/**
 * backend/services/qna/qnaOrchestrator.js
 *
 * Stage-reveal coordinator.
 *
 * Flow:
 *   classifyIntent -> planQuestion -> fetchFitbitData -> start all executor jobs
 *   -> return stage 0 as soon as ready -> reveal later stages one-by-one via controls
 */

const mongoose = require("mongoose");
const User = require("../../models/Users");
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
  adaptSleepStagesRange,
  adaptBreathingRateRange,
  adaptSpo2Range,
} = require("../fitbit/endpointAdapters");
const { resolveRequestedMetrics } = require("../fitbit/metricResolver");
const { buildNormalizedTable } = require("../fitbit/normalizeSeries");
const { generateStageFromExecutor } = require("./executorAgent");
const { planQuestion } = require("./plannerAgent");
const {
  appendStage,
  archiveOlderActiveBundles,
  createBranchBundle,
  createBundle,
  getBundleById,
  loadActiveBundleForUser,
  saveBundlePatch,
  setBundleRequestOwnership,
  setBundleStatus,
  setCurrentStageIndex: setBundleStageIndex,
  storePlannerResult,
  toStoredPlannerResult,
} = require("./bundleService");
const { recordSessionAudit } = require("./auditService");
const sessionService = require("./sessionService");
const {
  buildLegacyFallbackStage,
  buildStagePayload,
  createStageRecord,
  getCurrentStage,
  getLatestStage,
  getStageByIndex,
  replayStoredStage,
} = require("./stageService");

const ORCHESTRATOR_DEBUG = process.env.QNA_ORCHESTRATOR_DEBUG !== "false";
const BUNDLE_DATA_FETCH_TIMEOUT_MS = Number(process.env.QNA_BUNDLE_FETCH_TIMEOUT_MS || 4800);
const BUNDLE_LIFECYCLE_POLICY = String(process.env.QNA_BUNDLE_LIFECYCLE_POLICY || "archive").toLowerCase();
const DEFAULT_PENDING_VOICE = "Hang on, I'm still preparing the next chart.";
const DEFAULT_INITIAL_PENDING_VOICE = "Hang on, I'm still pulling your data. Ask me again in a moment.";
const DEFAULT_MAX_STAGE_COUNT = 4;

const TIME_SCOPE_DAY_CONFIG = {
  today: { days: 1, offset: 0 },
  yesterday: { days: 1, offset: 1 },
  last_night: { days: 1, offset: 1 },
  this_week: { days: 7, offset: 0 },
  last_week: { days: 7, offset: 7 },
  last_7_days: { days: 7, offset: 0 },
  last_30_days: { days: 30, offset: 0 },
};

const SLEEP_STAGE_METRICS = new Set([
  "sleep_deep",
  "sleep_light",
  "sleep_rem",
  "sleep_awake",
  "sleep_efficiency",
]);

const RUNTIME_STAGE_REQUESTS = new Map();

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

function sanitizeText(value, max = 220, fallback = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : fallback;
}

function normalizeUsername(username = "") {
  return String(username || "").trim().toLowerCase();
}

function isMongoReady() {
  return mongoose?.connection?.readyState === 1;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function withTimeout(promise, timeoutMs) {
  const ms = Math.max(0, Number(timeoutMs) || 0);
  if (!ms) return Promise.resolve({ timedOut: true, value: null });
  return Promise.race([
    Promise.resolve(promise).then((value) => ({ timedOut: false, value })),
    delay(ms).then(() => ({ timedOut: true, value: null })),
  ]);
}

function pickStageRole(stageSpec = {}, stageIndex = 0, stageCount = 0) {
  const explicit = String(stageSpec?.stageRole || "").trim().toLowerCase();
  if (["primary", "comparison", "deep_dive", "summary"].includes(explicit)) return explicit;

  const type = String(stageSpec?.stageType || "").trim().toLowerCase();
  if (stageIndex === 0) return "primary";
  if (type === "comparison") return "comparison";
  if (["takeaway"].includes(type) || stageIndex === stageCount - 1) return "summary";
  if (["relationship", "anomaly", "sleep_detail", "heart_recovery", "respiratory_health"].includes(type)) {
    return "deep_dive";
  }
  return "deep_dive";
}

function normalizeFollowupLabel(value = "") {
  const label = sanitizeText(value, 120, "").toLowerCase();
  if (!label) return "";
  if (/^(show more|more|next|continue|okay|ok)$/.test(label)) return "show more";
  if (/^(yes|yeah|sure)$/.test(label)) return "yes";
  if (/^(go back|back|previous)$/.test(label)) return "go back";
  if (/^(compare|compare that|compare this)$/.test(label)) return "compare that";
  if (/^(go deeper|tell me more|explore more)$/.test(label)) return "go deeper";
  if (/^(explain|explain that|explain this)$/.test(label)) return "explain that";
  if (/^(summarize|summarize this)$/.test(label)) return "summarize this";
  if (/^(start over|restart)$/.test(label)) return "start over";
  return label;
}

function uniqueFollowups(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = normalizeFollowupLabel(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function getPlannerStageCount(bundle = null) {
  const planned = Array.isArray(bundle?.stagesPlan) && bundle.stagesPlan.length
    ? bundle.stagesPlan.length
    : Array.isArray(bundle?.plannerOutput?.candidate_stage_types) && bundle.plannerOutput.candidate_stage_types.length
      ? bundle.plannerOutput.candidate_stage_types.length
      : Array.isArray(bundle?.stages) && bundle.stages.length
        ? Math.max(DEFAULT_MAX_STAGE_COUNT, bundle.stages.length)
        : DEFAULT_MAX_STAGE_COUNT;
  return Math.max(1, Math.min(6, Number(planned) || 1));
}

function applyStageProgressionPolicy(stageRecord = {}, options = {}) {
  const stageIndex = Math.max(0, Number(stageRecord?.stageIndex || 0));
  const stageCount = Math.max(1, Number(options.stageCount || options.plannedStageCount || DEFAULT_MAX_STAGE_COUNT) || 1);
  const moreAvailable = stageIndex < stageCount - 1;
  const followups = uniqueFollowups(stageRecord?.suggestedFollowups || []);
  const nextFollowups = [];

  if (moreAvailable) {
    nextFollowups.push("show more", "yes");
  }
  nextFollowups.push("go back", "explain that", "what does this mean");
  if (pickStageRole(stageRecord?.metadata?.stageSpec || {}, stageIndex, stageCount) !== "comparison") {
    nextFollowups.push("compare that");
  }
  if (!moreAvailable) nextFollowups.push("start over", "go deeper");
  nextFollowups.push(...followups);

  return {
    ...stageRecord,
    moreAvailable,
    suggestedFollowups: uniqueFollowups(nextFollowups).slice(0, 6),
    metadata: {
      ...(stageRecord?.metadata || {}),
      stageRole: pickStageRole(stageRecord?.metadata?.stageSpec || {}, stageIndex, stageCount),
      plannedStageCount: stageCount,
    },
  };
}

function buildPendingResponse({
  bundle = null,
  requestId = null,
  voiceAnswer = DEFAULT_PENDING_VOICE,
  activeStageIndex = null,
  requestedStageIndex = null,
  reason = "stage_pending",
  orchestrator = {},
} = {}) {
  const safeBundle = bundle && typeof bundle === "object" ? bundle : {};
  const currentIndex = activeStageIndex != null
    ? Math.max(0, Number(activeStageIndex) || 0)
    : Math.max(0, Number(safeBundle.currentStageIndex || 0));
  const targetIndex = requestedStageIndex == null
    ? currentIndex
    : Math.max(0, Number(requestedStageIndex) || 0);
  return {
    ok: false,
    status: "pending",
    answerReady: false,
    answer_ready: false,
    voiceAnswer: sanitizeText(voiceAnswer, 220, DEFAULT_PENDING_VOICE),
    voice_answer: sanitizeText(voiceAnswer, 220, DEFAULT_PENDING_VOICE),
    requestId: requestId || null,
    stageCount: getPlannerStageCount(safeBundle),
    activeStageIndex: currentIndex,
    requestedStageIndex: targetIndex,
    bundle_complete: false,
    payload: null,
    bundleId: safeBundle.bundleId || null,
    reason,
    orchestrator: {
      used: true,
      stageGenerator: "pending_stage",
      ...orchestrator,
    },
  };
}

function buildTerminalResponse({ bundle = null, requestId = null } = {}) {
  const stage = getCurrentStage(bundle) || getLatestStage(bundle) || createStageRecord({
    stageIndex: Math.max(0, Number(bundle?.currentStageIndex || 0)),
    title: "Last chart",
    spokenText: "That was the last visual in this analysis.",
    screenText: "That was the last visual in this analysis.",
    chartSpec: null,
    moreAvailable: false,
    suggestedFollowups: ["start over", "go deeper"],
    source: "stage_limit_reached",
  });
  const payload = buildStagePayload({
    bundle: { ...(bundle || {}), currentStageIndex: stage.stageIndex },
    stageRecord: {
      ...stage,
      spokenText: "That was the last visual in this analysis. Ask a new health question, or say go deeper.",
      screenText: stage.screenText || "That was the last visual in this analysis.",
      moreAvailable: false,
    },
    question: bundle?.question || "",
    requestId,
  });
  payload.answer_ready = true;
  payload.voice_answer = payload.spoken_answer = "That was the last visual in this analysis. Ask a new health question, or say go deeper.";
  payload.bundle_complete = true;

  return {
    ok: true,
    status: "complete",
    answerReady: true,
    answer_ready: true,
    voiceAnswer: payload.voice_answer,
    voice_answer: payload.voice_answer,
    requestId: requestId || null,
    stageCount: getPlannerStageCount(bundle),
    activeStageIndex: Number(stage.stageIndex || 0),
    bundle_complete: true,
    payload,
    stage,
    bundleId: bundle?.bundleId || null,
    orchestrator: {
      used: true,
      stageGenerator: "stage_limit_reached",
    },
  };
}

function buildStageResult({
  bundle = null,
  stage = null,
  requestId = null,
  voiceAnswerSource = "gpt",
  orchestrator = {},
} = {}) {
  const payload = buildStagePayload({
    bundle,
    stageRecord: stage,
    question: bundle?.question || "",
    requestId,
    voiceAnswerSource,
  });
  const activeStageIndex = Math.max(0, Number(stage?.stageIndex || payload?.activeStageIndex || 0));
  const bundleComplete = Boolean(payload?.bundle_complete);
  return {
    ok: true,
    status: bundleComplete ? "complete" : "ready",
    answerReady: true,
    answer_ready: true,
    voiceAnswer: payload.voice_answer,
    voice_answer: payload.voice_answer,
    requestId: requestId || payload.requestId || null,
    stageCount: Number(payload.stageCount || getPlannerStageCount(bundle)),
    activeStageIndex,
    bundle_complete: bundleComplete,
    payload,
    stage,
    bundleId: bundle?.bundleId || null,
    orchestrator: {
      used: true,
      ...orchestrator,
    },
  };
}

function getStagePlan(bundle = null) {
  if (Array.isArray(bundle?.stagesPlan) && bundle.stagesPlan.length) return bundle.stagesPlan.slice();
  const plannerStages = Array.isArray(bundle?.plannerOutput?.raw?.stages_plan) ? bundle.plannerOutput.raw.stages_plan : [];
  if (plannerStages.length) return plannerStages.slice();
  const candidateTypes = Array.isArray(bundle?.plannerOutput?.candidate_stage_types)
    ? bundle.plannerOutput.candidate_stage_types
    : [];
  return candidateTypes.map((stageType, idx) => ({
    stageIndex: idx,
    stageType,
    stageRole: pickStageRole({ stageType }, idx, candidateTypes.length),
    focusMetrics: Array.isArray(bundle?.metricsRequested) ? bundle.metricsRequested.slice(0, 4) : [],
    chartType: "bar",
    title: "",
    goal: "",
  }));
}

function findPlannedStageIndexByRole(bundle = null, role = "", currentIndex = 0) {
  const normalizedRole = String(role || "").trim().toLowerCase();
  if (!normalizedRole) return null;
  const stagesPlan = getStagePlan(bundle);
  const afterCurrent = stagesPlan.find((stageSpec) => {
    const stageIndex = Math.max(0, Number(stageSpec?.stageIndex || 0));
    return stageIndex > currentIndex && pickStageRole(stageSpec, stageIndex, stagesPlan.length) === normalizedRole;
  });
  if (afterCurrent) return Math.max(0, Number(afterCurrent.stageIndex || 0));
  const anyMatch = stagesPlan.find((stageSpec) => pickStageRole(stageSpec, stageSpec?.stageIndex || 0, stagesPlan.length) === normalizedRole);
  return anyMatch ? Math.max(0, Number(anyMatch.stageIndex || 0)) : null;
}

function getRuntimeKey(requestKey = null, username = "") {
  const safeRequestKey = sanitizeText(requestKey, 120, "");
  const safeUsername = normalizeUsername(username);
  return safeRequestKey || `user:${safeUsername}`;
}

function getRuntimeState({ requestKey = null, username = "" } = {}) {
  const exact = RUNTIME_STAGE_REQUESTS.get(getRuntimeKey(requestKey, username));
  if (exact) return exact;
  const byUser = RUNTIME_STAGE_REQUESTS.get(`user:${normalizeUsername(username)}`);
  if (byUser && (!requestKey || byUser.requestKey === requestKey)) return byUser;
  return null;
}

function setRuntimeState(state) {
  if (!state) return null;
  RUNTIME_STAGE_REQUESTS.set(getRuntimeKey(state.requestKey, state.username), state);
  RUNTIME_STAGE_REQUESTS.set(`user:${normalizeUsername(state.username)}`, state);
  return state;
}

function clearRuntimeState(username = null, requestKey = null) {
  if (!username && !requestKey) {
    RUNTIME_STAGE_REQUESTS.clear();
    return;
  }
  if (username) RUNTIME_STAGE_REQUESTS.delete(`user:${normalizeUsername(username)}`);
  if (requestKey) RUNTIME_STAGE_REQUESTS.delete(getRuntimeKey(requestKey, username || ""));
}

function completeRuntimeState(state) {
  if (!state) return;
  state.completed = true;
  state.completedAt = Date.now();
  setRuntimeState(state);
}

function normalizeInternalApiBase(candidate = "") {
  const value = String(candidate || "").trim();
  if (!value) return "";
  return value.replace(/\/+$/, "").replace(/\/api$/, "");
}

function resolveInternalApiBaseUrl() {
  const configuredBase = [
    process.env.REACT_APP_FETCH_DATA_URL,
    process.env.QNA_INTERNAL_API_URL,
    process.env.INTERNAL_API_URL,
    process.env.BACKEND_URL,
    process.env.API_URL,
    process.env.RENDER_EXTERNAL_URL,
    process.env.PUBLIC_BASE_URL,
  ]
    .map((value) => normalizeInternalApiBase(value))
    .find(Boolean);

  if (configuredBase) return configuredBase;

  const port = Number.parseInt(process.env.PORT, 10);
  const safePort = Number.isFinite(port) && port > 0 ? port : 5001;
  return `http://127.0.0.1:${safePort}`;
}

function isSingleDayScope(timeScope = "") {
  return ["today", "yesterday", "last_night"].includes(String(timeScope || "").toLowerCase());
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

function buildFitbitInternalUrl({ username, metricKey, startDate, endDate, timeScope = "last_7_days" }) {
  const base = resolveInternalApiBaseUrl();
  const user = String(username || "").toLowerCase();

  if (["sleep_minutes", "sleep_efficiency", "wake_minutes", "sleep_deep", "sleep_light", "sleep_rem", "sleep_awake"].includes(metricKey)) {
    if (isSingleDayScope(timeScope)) return `${base}/api/fitbit/${user}/sleep/single-day/date/${endDate}`;
    return `${base}/api/fitbit/${user}/sleep/range/date/${startDate}/${endDate}`;
  }
  if (metricKey === "breathing_rate") {
    if (isSingleDayScope(timeScope)) return `${base}/api/fitbit/${user}/br/single-day/date/${endDate}`;
    return `${base}/api/fitbit/${user}/br/range/date/${startDate}/${endDate}`;
  }
  if (metricKey === "spo2") {
    if (isSingleDayScope(timeScope)) return `${base}/api/fitbit/${user}/spo2/single-day/date/${endDate}`;
    return `${base}/api/fitbit/${user}/spo2/range/date/${startDate}/${endDate}`;
  }
  if (metricKey === "weight") {
    if (isSingleDayScope(timeScope)) return `${base}/api/fitbit/${user}/body/log/weight/date/${endDate}`;
    return `${base}/api/fitbit/${user}/body/log/weight/date/${startDate}/${endDate}`;
  }
  if (metricKey === "body_fat") {
    if (isSingleDayScope(timeScope)) return `${base}/api/fitbit/${user}/body/log/fat/date/${endDate}`;
    return `${base}/api/fitbit/${user}/body/log/fat/date/${startDate}/${endDate}`;
  }
  if (metricKey === "resting_hr") return `${base}/api/fitbit/${user}/heart/range/date/${startDate}/${endDate}`;
  if (metricKey === "heart_intraday") return `${base}/api/fitbit/${user}/heart/intraday/${startDate}`;
  if (metricKey === "steps_intraday") return `${base}/api/fitbit/${user}/activities/intraday/steps/${startDate}`;
  if (metricKey === "calories_intraday") return `${base}/api/fitbit/${user}/activities/intraday/calories/${startDate}`;
  if (metricKey === "distance_intraday") return `${base}/api/fitbit/${user}/activities/intraday/distance/${startDate}`;
  if (metricKey === "floors_intraday") return `${base}/api/fitbit/${user}/activities/intraday/floors/${startDate}`;
  if (metricKey === "calories") return `${base}/api/fitbit/${user}/activities/range/calories/date/${startDate}/${endDate}`;
  if (metricKey === "distance") return `${base}/api/fitbit/${user}/activities/range/distance/date/${startDate}/${endDate}`;
  if (metricKey === "floors") return `${base}/api/fitbit/${user}/activities/range/floors/date/${startDate}/${endDate}`;
  if (metricKey === "elevation") return `${base}/api/fitbit/${user}/activities/range/elevation/date/${startDate}/${endDate}`;
  if (metricKey === "hrv") return `${base}/api/fitbit/${user}/hrv/range/date/${startDate}/${endDate}`;
  return `${base}/api/fitbit/${user}/activities/range/steps/date/${startDate}/${endDate}`;
}

async function getUserContext(username) {
  try {
    const user = await User.findOne({ username: String(username || "").toLowerCase() });
    if (!user) return null;
    return {
      age: user?.userProfile?.age || null,
      healthGoals: Array.isArray(user?.userProfile?.healthGoals) ? user.userProfile.healthGoals : [],
      preferences: {
        dailyStepGoal: Number(user?.userProfile?.preferences?.dailyStepGoal) || 10000,
        sleepGoalMinutes: Number(user?.userProfile?.preferences?.sleepGoalMinutes) || 480,
      },
    };
  } catch (error) {
    orchestratorWarn("failed to load user context", { message: error?.message || String(error) });
    return null;
  }
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
  if (SLEEP_STAGE_METRICS.has(metricKey)) return adaptSleepStagesRange(payload);
  if (metricKey === "breathing_rate") return adaptBreathingRateRange(payload);
  if (metricKey === "spo2") return adaptSpo2Range(payload);
  if (metricKey.endsWith("_intraday")) {
    const resource = metricKey.replace(/_intraday$/, "");
    return adaptIntradayActivity(payload, resource);
  }
  return adaptStepsRange(payload);
}

async function fetchJsonWithTimeout(url, timeoutMs = BUNDLE_DATA_FETCH_TIMEOUT_MS) {
  const ms = Math.max(1200, Number(timeoutMs) || BUNDLE_DATA_FETCH_TIMEOUT_MS);
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

async function fetchFitbitDataForBundle({ bundle, username, metricsNeeded, timeScope, fetchTimeoutMs = null } = {}) {
  if (!bundle?.bundleId) return bundle;

  const metrics = resolveRequestedMetrics(metricsNeeded || []).slice(0, 8);
  const window = computeDateWindow(timeScope || "last_7_days");
  const existingCache = bundle.rawFitbitCache && typeof bundle.rawFitbitCache === "object" ? { ...bundle.rawFitbitCache } : {};
  const metricSeriesMap = {};
  const sleepStageRequested = metrics.filter((m) => SLEEP_STAGE_METRICS.has(m));
  const allSleepStagesCached = sleepStageRequested.every((m) => {
    const entry = existingCache[m];
    return entry
      && entry.timeScope === window.timeScope
      && entry.startDate === window.startDate
      && entry.endDate === window.endDate
      && Array.isArray(entry.adaptedPoints)
      && entry.adaptedPoints.length > 0;
  });

  if (sleepStageRequested.length > 0 && !allSleepStagesCached) {
    const sleepUrl = buildFitbitInternalUrl({
      username,
      metricKey: "sleep_minutes",
      startDate: window.startDate,
      endDate: window.endDate,
      timeScope: window.timeScope,
    });
    try {
      const sleepRaw = await fetchJsonWithTimeout(sleepUrl, fetchTimeoutMs || BUNDLE_DATA_FETCH_TIMEOUT_MS);
      const sleepStagePoints = adaptSleepStagesRange(sleepRaw);
      for (const stageMetric of SLEEP_STAGE_METRICS) {
        existingCache[stageMetric] = {
          metric: stageMetric,
          timeScope: window.timeScope,
          startDate: window.startDate,
          endDate: window.endDate,
          fetchedAt: new Date().toISOString(),
          sourceUrl: sleepUrl,
          raw: sleepRaw,
          adaptedPoints: sleepStagePoints,
        };
      }
    } catch (error) {
      orchestratorWarn("sleep stage dedup fetch failed", {
        bundleId: bundle.bundleId,
        message: error?.message || String(error),
      });
    }
  }

  for (const metric of metrics) {
    const cacheEntry = existingCache[metric];
    const isReusable = cacheEntry
      && cacheEntry.timeScope === window.timeScope
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
      timeScope: window.timeScope,
    });
    try {
      const raw = await fetchJsonWithTimeout(url, fetchTimeoutMs || BUNDLE_DATA_FETCH_TIMEOUT_MS);
      const adaptedPoints = mapMetricPayload(metric, raw);
      metricSeriesMap[metric] = adaptedPoints;
      existingCache[metric] = {
        metric,
        timeScope: window.timeScope,
        startDate: window.startDate,
        endDate: window.endDate,
        fetchedAt: new Date().toISOString(),
        sourceUrl: url,
        raw,
        adaptedPoints,
      };
    } catch (error) {
      orchestratorWarn("metric fetch failed", {
        bundleId: bundle.bundleId,
        metric,
        message: error?.message || String(error),
      });
      metricSeriesMap[metric] = [];
      existingCache[metric] = {
        metric,
        timeScope: window.timeScope,
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
  return saveBundlePatch(bundle.bundleId, {
    metricsRequested: metrics,
    rawFitbitCache: existingCache,
    normalizedTable,
  }) || bundle;
}

function buildCombinedVoiceAnswer(stages = []) {
  const parts = (Array.isArray(stages) ? stages : [])
    .map((stage) => sanitizeText(stage?.spokenText, 600, ""))
    .filter(Boolean);
  if (!parts.length) return "I couldn't generate a health summary right now. Please try again.";
  return parts.join(' <break time="2s"/> ');
}

function buildNarrationTimings(stages = []) {
  const timings = [];
  let elapsed = 0;
  for (const stage of stages) {
    timings.push(elapsed);
    const words = sanitizeText(stage?.spokenText, 600, "").split(/\s+/).filter(Boolean).length;
    const narrationMs = Math.max(1500, Math.round((words / 120) * 60000));
    elapsed += narrationMs + 2000;
  }
  return timings;
}

async function applyLifecyclePolicy(username, keepBundleId) {
  if (BUNDLE_LIFECYCLE_POLICY === "none") return;
  await archiveOlderActiveBundles(username, keepBundleId, `stage_reveal_${BUNDLE_LIFECYCLE_POLICY}`);
}

async function persistPlannerResult(bundleId, plannerResult) {
  const stored = await storePlannerResult(bundleId, {
    ...toStoredPlannerResult(plannerResult),
    plannerMeta: {
      ...(plannerResult?.plannerMeta || {}),
      phase: "stage_reveal",
    },
  });
  if (Array.isArray(plannerResult?.stagesPlan) && plannerResult.stagesPlan.length) {
    await saveBundlePatch(bundleId, { stagesPlan: plannerResult.stagesPlan });
  }
  return stored || null;
}

function getDefaultDeps() {
  return {
    beginRequest: sessionService.beginRequest,
    endRequest: sessionService.endRequest,
    setRequestBundleOwnership: sessionService.setRequestBundleOwnership,
    setLatestRequestKey: sessionService.setLatestRequestKey,
    setActiveBundleForUser: sessionService.setActiveBundleForUser,
    setActiveBundleId: sessionService.setActiveBundleId,
    setRequestedStageIndex: sessionService.setRequestedStageIndex,
    setSessionStageIndex: sessionService.setCurrentStageIndex,
    setLastDeliveredStageIndex: sessionService.setLastDeliveredStageIndex,
    applyStageReplayState: sessionService.applyStageReplayState,
    getSessionState: sessionService.getActiveSessionState,
    getActiveBundleId: sessionService.getActiveBundleId,
    isCurrentRequest: sessionService.isCurrentRequest,
    isStaleRequest: sessionService.isStaleRequest,
    getUserContext,
    isMongoReady,
    planQuestion,
    loadActiveBundleForUser,
    getBundleById,
    setBundleRequestOwnership,
    startNewBundleFromPlanner: async ({
      username,
      question,
      plannerResult,
      requestKey,
      requestSource = "alexa",
    }) => {
      const bundle = await createBundle({
        username,
        question,
        plannerOutput: toStoredPlannerResult(plannerResult),
        metricsRequested: plannerResult.metricsNeeded || [],
        status: "active",
        requestKey,
        requestSource,
      });
      await persistPlannerResult(bundle.bundleId, plannerResult);
      await applyLifecyclePolicy(username, bundle.bundleId);
      return bundle;
    },
    branchBundle: async ({
      activeBundle,
      username,
      question,
      plannerResult,
      requestKey,
      requestSource = "followup",
    }) => {
      const bundle = await createBranchBundle({
        sourceBundle: activeBundle,
        username,
        question,
        plannerOutput: toStoredPlannerResult(plannerResult),
        metricsRequested: plannerResult.metricsNeeded || [],
        requestKey,
        requestSource,
      });
      await persistPlannerResult(bundle.bundleId, plannerResult);
      await applyLifecyclePolicy(username, bundle.bundleId);
      return bundle;
    },
    continueExistingBundle: async ({ activeBundle }) => activeBundle,
    ensureBundleHasNormalizedData: async ({ bundle, username, plannerResult }) => fetchFitbitDataForBundle({
      bundle,
      username,
      metricsNeeded: plannerResult?.metricsNeeded || bundle?.metricsRequested,
      timeScope: plannerResult?.timeScope || bundle?.plannerOutput?.time_scope,
    }),
    tryExecutorStageGeneration: async ({ resolvedBundle, explicitStageIndex = 0, requestId = null, stageSpec = null, userContext = null }) => {
      const stageResult = await generateStageFromExecutor({
        bundle: resolvedBundle,
        question: resolvedBundle?.question || "",
        stageIndex: explicitStageIndex,
        userContext,
        stageSpec,
        requestId,
      });
      if (!stageResult?.ok || !stageResult?.stage) {
        return {
          ok: false,
          status: "error",
          reason: stageResult?.error || "executor_stage_failed",
        };
      }
      return {
        ok: true,
        stage: stageResult.stage,
        stageGenerator: explicitStageIndex === 0 ? "executor_stage1" : "executor_next_stage",
      };
    },
    persistStageResult: async ({ bundle, stageRecord, requestKey = null }) => {
      const updatedBundle = await appendStage(bundle.bundleId, stageRecord, {
        requestKey,
        rejectStaleRequest: Boolean(requestKey),
      });
      if (!updatedBundle) {
        return {
          bundle,
          stageRecord,
        };
      }
      await setBundleStatus(
        updatedBundle.bundleId,
        stageRecord.moreAvailable ? "partial" : "ready",
        {},
        "stage_reveal_stage_ready",
        {
          requestKey,
          rejectStaleRequest: Boolean(requestKey),
        }
      );
      return {
        bundle: updatedBundle,
        stageRecord,
      };
    },
    setBundleStageIndex,
    setBundleStatus,
    buildLegacyFallbackStage: ({ bundle, requestId, question, stageIndex = 0, reason = "fallback" }) => buildLegacyFallbackStage({
      legacyResult: {
        payload: {
          voice_answer: "I had trouble generating that chart, so here is a simpler summary.",
          spoken_answer: "I had trouble generating that chart, so here is a simpler summary.",
          summary: { shortText: "Fallback summary" },
        },
      },
      payload: {
        voice_answer: "I had trouble generating that chart, so here is a simpler summary.",
        spoken_answer: "I had trouble generating that chart, so here is a simpler summary.",
        summary: { shortText: "Fallback summary" },
      },
      plannerResult: bundle?.plannerOutput || null,
      stageIndex,
      requestId,
      question,
      source: `legacy_fallback_${reason}`,
    }),
    answerFollowupFromPayload: async ({ payload, question }) => ({
      answer: sanitizeText(question, 220, payload?.voice_answer || payload?.spoken_answer || ""),
      answer_ready: true,
      voice_answer_source: "fallback",
      payload: {
        ...(payload || {}),
        answer_ready: true,
        voice_answer_source: "fallback",
        voice_answer: sanitizeText(question, 220, payload?.voice_answer || payload?.spoken_answer || ""),
        spoken_answer: sanitizeText(question, 220, payload?.voice_answer || payload?.spoken_answer || ""),
      },
    }),
  };
}

function mergeDeps(overrides = null) {
  return {
    ...getDefaultDeps(),
    ...(overrides || {}),
  };
}

async function markActiveStage({
  deps,
  username,
  bundleId,
  stageIndex,
  requestKey = null,
}) {
  deps.setRequestedStageIndex?.(username, null);
  deps.setSessionStageIndex?.(username, stageIndex);
  await deps.setBundleStageIndex?.(bundleId, stageIndex, {
    requestKey,
    rejectStaleRequest: Boolean(requestKey),
  });
  deps.applyStageReplayState?.(username, { activeStageIndex: stageIndex, requestedStageIndex: null });
  // Track that this stage was actually delivered so resume_pending auto-advance
  // can distinguish "delivered stage 0" from "initial state (also 0)".
  deps.setLastDeliveredStageIndex?.(username, stageIndex);
}

async function launchBackgroundStageJobs({
  deps,
  username,
  bundle,
  plannerResult,
  userContext,
  requestKey,
  requestId,
}) {
  const stagesPlan = getStagePlan({
    ...bundle,
    stagesPlan: bundle?.stagesPlan?.length ? bundle.stagesPlan : plannerResult?.stagesPlan || [],
    plannerOutput: bundle?.plannerOutput || toStoredPlannerResult(plannerResult),
  });
  const runtime = setRuntimeState({
    username,
    requestKey,
    requestId: requestId || requestKey,
    bundleId: bundle.bundleId,
    stagesPlan,
    readyStages: new Map(),
    stagePromises: new Map(),
    completed: false,
    startedAt: Date.now(),
  });

  const stageCount = Math.max(1, stagesPlan.length || 1);
  stagesPlan.forEach((stageSpec, rawIndex) => {
    const stageIndex = Math.max(0, Number(stageSpec?.stageIndex ?? rawIndex));
    const promise = (async () => {
      try {
        const currentBundle = await deps.getBundleById(bundle.bundleId) || bundle;
        if (deps.isStaleRequest?.(username, requestKey)) {
          return { ok: false, stale: true, reason: "stale_request" };
        }

        const generation = await deps.tryExecutorStageGeneration({
          resolvedBundle: currentBundle,
          explicitStageIndex: stageIndex,
          requestId,
          stageSpec,
          userContext,
        });

        let nextStage = generation?.stage || null;
        if (!generation?.ok || !nextStage) {
          nextStage = deps.buildLegacyFallbackStage?.({
            bundle: currentBundle,
            requestId,
            question: currentBundle.question || "",
            stageIndex,
            reason: generation?.reason || "executor_failed",
          });
          generation.ok = Boolean(nextStage);
          generation.reason = generation?.reason || "executor_failed";
        }

        if (!nextStage) {
          return {
            ok: false,
            reason: generation?.reason || "stage_not_generated",
          };
        }

        nextStage = applyStageProgressionPolicy({
          ...nextStage,
          metadata: {
            ...(nextStage.metadata || {}),
            stageSpec,
          },
        }, { stageCount });

        const persisted = await deps.persistStageResult({
          bundle: currentBundle,
          stageRecord: nextStage,
          requestKey,
        });
        runtime.readyStages.set(stageIndex, {
          bundle: persisted?.bundle || currentBundle,
          stage: nextStage,
        });
        if (stageIndex === stageCount - 1) completeRuntimeState(runtime);
        return {
          ok: true,
          bundle: persisted?.bundle || currentBundle,
          stage: nextStage,
          stageGenerator: generation?.stageGenerator || (stageIndex === 0 ? "executor_stage1" : "executor_next_stage"),
        };
      } catch (error) {
        orchestratorWarn("background stage job failed", {
          username,
          requestKey,
          stageIndex,
          message: error?.message || String(error),
        });
        return {
          ok: false,
          reason: error?.message || "stage_job_failed",
        };
      }
    })();

    runtime.stagePromises.set(stageIndex, promise);
  });

  Promise.allSettled([...runtime.stagePromises.values()]).then(() => {
    completeRuntimeState(runtime);
    deps.endRequest?.({
      username,
      requestKey,
      status: "completed",
      bundleId: bundle.bundleId,
    });
  }).catch(() => {});

  return runtime;
}

async function getStageIfReady({ deps, username, requestKey, bundleId, stageIndex }) {
  const freshBundle = bundleId ? await deps.getBundleById(bundleId) : null;
  const storedStage = getStageByIndex(freshBundle, stageIndex);
  if (storedStage) return { ok: true, bundle: freshBundle, stage: storedStage };

  const runtime = getRuntimeState({ requestKey, username });
  const readyStage = runtime?.readyStages?.get(stageIndex) || null;
  if (readyStage?.stage) return { ok: true, bundle: readyStage.bundle || freshBundle, stage: readyStage.stage };
  return { ok: false, bundle: freshBundle };
}

async function waitForStageIfNeeded({
  deps,
  username,
  requestKey,
  bundleId,
  stageIndex,
  timeoutMs,
}) {
  const immediate = await getStageIfReady({ deps, username, requestKey, bundleId, stageIndex });
  if (immediate.ok) return { ok: true, ...immediate };

  const runtime = getRuntimeState({ requestKey, username });
  const promise = runtime?.stagePromises?.get(stageIndex);
  if (!promise) return { ok: false, bundle: immediate.bundle };
  const waited = await withTimeout(promise, timeoutMs);
  if (waited.timedOut) return { ok: false, bundle: immediate.bundle };
  return getStageIfReady({ deps, username, requestKey, bundleId, stageIndex });
}

async function maybeStartFollowupBundle({
  deps,
  username,
  requestId,
  activeBundle,
  action,
}) {
  const baseQuestion = sanitizeText(activeBundle?.question, 240, "this health topic");
  const followupQuestion = action === "go_deeper"
    ? `Give me a deeper analysis of ${baseQuestion}`
    : `Compare ${baseQuestion}`;
  return startQuestionWithOrchestrator({
    username,
    question: followupQuestion,
    requestId,
    requestSource: "followup",
    __deps: deps,
  });
}

async function startQuestionWithOrchestrator({
  username,
  question,
  enrichedIntent = null,
  requestId = null,
  requestSource = "alexa",
  voiceDeadlineMs = 4200,
  sessionHints = null,
  __deps = null,
} = {}) {
  const deps = mergeDeps(__deps);
  const safeUsername = normalizeUsername(username);
  const safeQuestion = sanitizeText(question, 320, "");
  const begin = deps.beginRequest?.({
    username: safeUsername,
    source: requestSource,
    requestKey: requestId || null,
  }) || { ok: true, requestKey: requestId || `req_${Date.now()}`, concurrentDetected: false };
  const requestKey = begin.requestKey || requestId || `req_${Date.now()}`;

  deps.setLatestRequestKey?.(safeUsername, requestKey);
  if (sessionHints?.activeStageIndex != null) deps.setSessionStageIndex?.(safeUsername, sessionHints.activeStageIndex);

  if (deps.isCurrentRequest && !deps.isCurrentRequest({ username: safeUsername, requestKey })) {
    return {
      ok: false,
      stale: true,
      status: "stale",
      reason: "stale request rejected",
    };
  }

  try {
    if (__deps) {
      const userContext = await deps.getUserContext?.(safeUsername).catch(() => null);
      const plannerResult = await deps.planQuestion({
        question: safeQuestion,
        username: safeUsername,
        enrichedIntent,
        userContext,
      });
      let bundleAction = "new";
      let resolvedBundle = null;
      const activeBundle = await deps.loadActiveBundleForUser?.(safeUsername);
      const plannerMode = String(plannerResult?.mode || "").trim().toLowerCase();

      if (activeBundle && plannerMode === "branch_analysis") {
        bundleAction = "branch";
        resolvedBundle = await deps.branchBundle?.({
          activeBundle,
          username: safeUsername,
          question: safeQuestion,
          plannerResult,
          requestKey,
          requestSource,
        });
      } else if (activeBundle && plannerMode === "continue_analysis") {
        bundleAction = "continue";
        resolvedBundle = await deps.continueExistingBundle?.({
          activeBundle,
          username: safeUsername,
          question: safeQuestion,
          plannerResult,
          requestKey,
          requestSource,
        });
      }

      if (!resolvedBundle) {
        resolvedBundle = await deps.startNewBundleFromPlanner?.({
          username: safeUsername,
          question: safeQuestion,
          plannerResult,
          requestKey,
          requestSource,
        });
        bundleAction = "new";
      }

      deps.setActiveBundleForUser?.(safeUsername, resolvedBundle?.bundleId || null);
      deps.setSessionStageIndex?.(safeUsername, sessionHints?.activeStageIndex ?? 0);

      const stagePlan = getStagePlan({
        ...resolvedBundle,
        stagesPlan: plannerResult?.stagesPlan || [],
        plannerOutput: { ...(resolvedBundle?.plannerOutput || {}), candidate_stage_types: plannerResult?.candidateStageTypes || [] },
      });
      const generation = await deps.tryExecutorStageGeneration({
        resolvedBundle,
        explicitStageIndex: bundleAction === "continue"
          ? Math.max(0, Number(resolvedBundle?.currentStageIndex || 0)) + 1
          : 0,
        requestId,
        stageSpec: stagePlan[bundleAction === "continue" ? Math.max(0, Number(resolvedBundle?.currentStageIndex || 0)) + 1 : 0] || null,
        userContext,
      });
      let stage = generation?.stage || null;
      let stageGenerator = generation?.stageGenerator || (bundleAction === "continue" ? "executor_next_stage" : "executor_stage1");
      let fallbackReason = null;
      if (!generation?.ok || !stage) {
        stage = deps.buildLegacyFallbackStage?.({
          bundle: resolvedBundle,
          requestId,
          question: safeQuestion,
          stageIndex: bundleAction === "continue" ? Math.max(0, Number(resolvedBundle?.currentStageIndex || 0)) + 1 : 0,
          reason: generation?.reason || "executor_failed",
        });
        stageGenerator = "legacy_fallback";
        fallbackReason = generation?.reason || "executor_failed";
      }
      stage = applyStageProgressionPolicy(stage, { stageCount: stagePlan.length || 1 });
      const persisted = await deps.persistStageResult?.({ bundle: resolvedBundle, stageRecord: stage, requestKey }) || { bundle: resolvedBundle };
      await markActiveStage({
        deps,
        username: safeUsername,
        bundleId: resolvedBundle.bundleId,
        stageIndex: stage.stageIndex,
        requestKey,
      });
      return buildStageResult({
        bundle: persisted.bundle || resolvedBundle,
        stage,
        requestId,
        orchestrator: {
          bundleAction,
          stageGenerator,
          ...(fallbackReason ? { fallbackReason } : {}),
        },
      });
    }

    const userContext = await deps.getUserContext?.(safeUsername).catch(() => null);
    const plannerResult = await deps.planQuestion({
      question: safeQuestion,
      username: safeUsername,
      enrichedIntent,
      userContext,
    });

    let bundleAction = "new";
    let resolvedBundle = null;
    const activeBundle = await deps.loadActiveBundleForUser?.(safeUsername);
    const plannerMode = String(plannerResult?.mode || "").trim().toLowerCase();

    if (activeBundle && plannerMode === "branch_analysis") {
      bundleAction = "branch";
      resolvedBundle = await deps.branchBundle?.({
        activeBundle,
        username: safeUsername,
        question: safeQuestion,
        plannerResult,
        requestKey,
        requestSource,
      });
    } else if (activeBundle && plannerMode === "continue_analysis") {
      bundleAction = "continue";
      resolvedBundle = await deps.continueExistingBundle?.({
        activeBundle,
        username: safeUsername,
        question: safeQuestion,
        plannerResult,
        requestKey,
        requestSource,
      });
    }

    if (!resolvedBundle) {
      resolvedBundle = await deps.startNewBundleFromPlanner?.({
        username: safeUsername,
        question: safeQuestion,
        plannerResult,
        requestKey,
        requestSource,
      });
      bundleAction = "new";
    }

    if (!resolvedBundle?.bundleId) {
      throw new Error("failed to initialize bundle");
    }

    deps.setActiveBundleForUser?.(safeUsername, resolvedBundle.bundleId);
    deps.setRequestBundleOwnership?.({ username: safeUsername, requestKey, bundleId: resolvedBundle.bundleId });
    await deps.setBundleRequestOwnership?.(resolvedBundle.bundleId, requestKey, requestSource);
    resolvedBundle = await deps.ensureBundleHasNormalizedData?.({
      bundle: resolvedBundle,
      username: safeUsername,
      plannerResult,
      requestKey,
    }) || resolvedBundle;

    // Convert Mongoose document to a plain JS object before spreading.
    // In Mongoose 8, schema paths are stored internally and are not enumerable
    // own properties, so `{...mongooseDoc}` silently loses fields like `bundleId`.
    // Calling .toObject() first guarantees every field is a plain own property.
    const resolvedBundlePojo = (typeof resolvedBundle.toObject === "function")
      ? resolvedBundle.toObject()
      : Object.assign({}, resolvedBundle);

    const runtime = await launchBackgroundStageJobs({
      deps,
      username: safeUsername,
      bundle: {
        ...resolvedBundlePojo,
        stagesPlan: getStagePlan({ ...resolvedBundlePojo, stagesPlan: plannerResult?.stagesPlan || [] }),
      },
      plannerResult,
      userContext,
      requestKey,
      requestId,
    });

    deps.setRequestedStageIndex?.(safeUsername, 0);
    const stageZero = await waitForStageIfNeeded({
      deps,
      username: safeUsername,
      requestKey,
      bundleId: resolvedBundle.bundleId,
      stageIndex: 0,
      timeoutMs: voiceDeadlineMs,
    });

    if (!stageZero.ok) {
      return buildPendingResponse({
        bundle: resolvedBundle,
        requestId: requestId || requestKey,
        voiceAnswer: DEFAULT_INITIAL_PENDING_VOICE,
        activeStageIndex: 0,
        requestedStageIndex: 0,
        reason: "initial_stage_pending",
        orchestrator: {
          bundleAction,
          requestKey,
        },
      });
    }

    await markActiveStage({
      deps,
      username: safeUsername,
      bundleId: resolvedBundle.bundleId,
      stageIndex: 0,
      requestKey,
    });
    recordSessionAudit?.({
      eventType: "question_stage0_ready",
      username: safeUsername,
      bundleId: resolvedBundle.bundleId,
      requestKey,
      stageCount: runtime.stagesPlan.length,
    });

    return buildStageResult({
      bundle: stageZero.bundle || resolvedBundle,
      stage: stageZero.stage,
      requestId: requestId || requestKey,
      orchestrator: {
        bundleAction,
        stageGenerator: "executor_stage1",
        requestKey,
      },
    });
  } catch (error) {
    orchestratorError("startQuestionWithOrchestrator failed", error);
    deps.endRequest?.({
      username: safeUsername,
      requestKey,
      status: "failed",
    });
    return {
      ok: false,
      status: "error",
      answerReady: false,
      answer_ready: false,
      voiceAnswer: "I had trouble gathering your health data. Please try again.",
      voice_answer: "I had trouble gathering your health data. Please try again.",
      requestId: requestId || requestKey,
      payload: null,
      bundleId: null,
      reason: error?.message || "question_failed",
      orchestrator: {
        used: true,
        stageGenerator: "error",
      },
    };
  }
}

async function handleNavigationControl({
  username,
  action,
  stageIndex = null,
  requestId = null,
  __deps = null,
} = {}) {
  const deps = mergeDeps(__deps);
  const safeUsername = normalizeUsername(username);
  const activeBundleId = deps.getActiveBundleId?.(safeUsername);
  const bundle = activeBundleId ? await deps.getBundleById?.(activeBundleId) : await deps.loadActiveBundleForUser?.(safeUsername);

  if (!bundle?.bundleId) {
    return buildPendingResponse({
      requestId,
      voiceAnswer: "I don't have an active analysis yet. Ask a health question first.",
      reason: "missing_active_bundle",
      orchestrator: {
        stageGenerator: "missing_bundle",
      },
    });
  }

  const currentIndex = Math.max(0, Number(bundle.currentStageIndex || 0));
  const stageCount = getPlannerStageCount(bundle);
  let targetIndex = currentIndex;
  let role = null;

  if (action === "stage_goto" && stageIndex != null) targetIndex = Math.max(0, Number(stageIndex) || 0);
  else if (action === "stage_back") targetIndex = Math.max(0, currentIndex - 1);
  else if (action === "stage_next" || action === "show_more") targetIndex = currentIndex + 1;
  else if (action === "compare") role = "comparison";
  else if (action === "go_deeper") role = "deep_dive";

  if (role) {
    const plannedTarget = findPlannedStageIndexByRole(bundle, role, currentIndex);
    if (plannedTarget == null) {
      return maybeStartFollowupBundle({
        deps,
        username: safeUsername,
        requestId,
        activeBundle: bundle,
        action,
      });
    }
    targetIndex = plannedTarget;
  }

  const currentStage = getCurrentStage(bundle) || getLatestStage(bundle);
  if (targetIndex >= stageCount || (action !== "stage_back" && currentStage && currentStage.moreAvailable === false && targetIndex > currentIndex)) {
    return buildTerminalResponse({ bundle, requestId });
  }

  const replay = replayStoredStage({
    bundle,
    stageIndex: targetIndex,
    question: bundle.question || "",
    requestId,
  });
  if (replay?.ok && replay.stage) {
    await markActiveStage({
      deps,
      username: safeUsername,
      bundleId: bundle.bundleId,
      stageIndex: replay.stage.stageIndex,
      requestKey: requestId || null,
    });
    const refreshed = await deps.getBundleById?.(bundle.bundleId) || bundle;
    return buildStageResult({
      bundle: refreshed,
      stage: replay.stage,
      requestId,
      orchestrator: {
        stageGenerator: "replay_stored_stage",
        controlAction: action,
      },
    });
  }

  // ── Runtime map check ──────────────────────────────────────────────────────
  // Before falling through to a fresh GPT generation, check the in-memory
  // runtime.readyStages map.  This handles the race where the background job
  // has finished generating the stage but has not yet persisted it to MongoDB
  // (or the MongoDB write is in-flight).  getStageIfReady checks both MongoDB
  // and the runtime map so it covers all "ready" states.
  const runtimeCheck = await getStageIfReady({
    deps,
    username: safeUsername,
    requestKey: requestId || null,   // falls back to username-based lookup when null
    bundleId: bundle.bundleId,
    stageIndex: targetIndex,
  });
  if (runtimeCheck.ok && runtimeCheck.stage) {
    orchestratorLog("handleNavigationControl: stage found in runtime map, skipping regeneration", {
      username: safeUsername,
      stageIndex: targetIndex,
      bundleId: bundle.bundleId,
    });
    await markActiveStage({
      deps,
      username: safeUsername,
      bundleId: bundle.bundleId,
      stageIndex: targetIndex,
      requestKey: requestId || null,
    });
    const refreshed = await deps.getBundleById?.(bundle.bundleId) || runtimeCheck.bundle || bundle;
    return buildStageResult({
      bundle: refreshed,
      stage: runtimeCheck.stage,
      requestId,
      orchestrator: {
        stageGenerator: "runtime_map_stage",
        controlAction: action,
      },
    });
  }
  // ── End runtime map check ──────────────────────────────────────────────────

  if (__deps) {
    const stagePlan = getStagePlan(bundle);
    const generation = await deps.tryExecutorStageGeneration({
      resolvedBundle: bundle,
      explicitStageIndex: targetIndex,
      requestId,
      stageSpec: stagePlan[targetIndex] || null,
      userContext: null,
    });
      let stage = generation?.stage || null;
      let stageGenerator = generation?.stageGenerator || "executor_next_stage";
      let fallbackReason = null;
      if (!generation?.ok || !stage) {
        stage = deps.buildLegacyFallbackStage?.({
          bundle,
          requestId,
          question: bundle.question || "",
          stageIndex: targetIndex,
          reason: generation?.reason || "executor_failed",
        });
        stageGenerator = "legacy_fallback";
        fallbackReason = generation?.reason || "executor_failed";
      }
      if (stage) {
        stage = applyStageProgressionPolicy(stage, { stageCount });
        const persisted = await deps.persistStageResult?.({ bundle, stageRecord: stage, requestKey: requestId || null }) || { bundle };
      await markActiveStage({
        deps,
        username: safeUsername,
        bundleId: bundle.bundleId,
        stageIndex: targetIndex,
        requestKey: requestId || null,
      });
        return buildStageResult({
          bundle: persisted.bundle || bundle,
          stage,
          requestId,
          orchestrator: {
            stageGenerator,
            controlAction: action,
            ...(fallbackReason ? { fallbackReason } : {}),
          },
        });
      }
  }

  deps.setRequestedStageIndex?.(safeUsername, targetIndex);
  return buildPendingResponse({
    bundle,
    requestId,
    voiceAnswer: DEFAULT_PENDING_VOICE,
    activeStageIndex: currentIndex,
    requestedStageIndex: targetIndex,
    reason: "requested_stage_pending",
    orchestrator: {
      stageGenerator: "pending_stage",
      controlAction: action,
    },
  });
}

async function handleControlWithOrchestrator({
  username,
  action,
  requestId = null,
  sessionHints = null,
  __deps = null,
} = {}) {
  const deps = mergeDeps(__deps);
  const safeUsername = normalizeUsername(username);
  const normalizedAction = String(action || "").trim().toLowerCase();
  if (sessionHints?.activeStageIndex != null) deps.setSessionStageIndex?.(safeUsername, sessionHints.activeStageIndex);

  if (normalizedAction === "resume_pending") {
    const session = deps.getSessionState?.(safeUsername) || {};
    const bundleId = deps.getActiveBundleId?.(safeUsername) || session.activeBundleId || null;
    const bundle = bundleId ? await deps.getBundleById?.(bundleId) : await deps.loadActiveBundleForUser?.(safeUsername);
    let targetIndex = session.requestedStageIndex == null
      ? Math.max(0, Number(bundle?.currentStageIndex || 0))
      : Math.max(0, Number(session.requestedStageIndex || 0));
    const requestKey = requestId || session.activeRequestKey || session.latestRequestKey || null;

    // Auto-advance past already-delivered stages so repeated resume_pending
    // calls cycle through the slide deck instead of replaying stage 0.
    const stageCount = getPlannerStageCount(bundle);
    const lastDelivered = Number(session.lastDeliveredStageIndex ?? -1);
    const alreadyDelivered = lastDelivered >= targetIndex && bundle?.stages?.[targetIndex];
    if (alreadyDelivered && lastDelivered + 1 < stageCount) {
      targetIndex = lastDelivered + 1;
    } else if (alreadyDelivered && lastDelivered + 1 >= stageCount) {
      return buildTerminalResponse({ bundle, requestId: requestId || requestKey });
    }

    const ready = await getStageIfReady({
      deps,
      username: safeUsername,
      requestKey,
      bundleId: bundle?.bundleId || null,
      stageIndex: targetIndex,
    });
    if (!ready.ok || !ready.stage) {
      return buildPendingResponse({
        bundle,
        requestId: requestId || requestKey,
        voiceAnswer: DEFAULT_PENDING_VOICE,
        activeStageIndex: bundle?.currentStageIndex || 0,
        requestedStageIndex: targetIndex,
        reason: "resume_pending_wait",
        orchestrator: {
          controlAction: normalizedAction,
          stageGenerator: "pending_stage",
        },
      });
    }
    await markActiveStage({
      deps,
      username: safeUsername,
      bundleId: ready.bundle?.bundleId || bundle?.bundleId,
      stageIndex: targetIndex,
      requestKey,
    });
    return buildStageResult({
      bundle: ready.bundle || bundle,
      stage: ready.stage,
      requestId: requestId || requestKey,
      orchestrator: {
        controlAction: normalizedAction,
        stageGenerator: targetIndex === 0 ? "executor_stage1" : "executor_next_stage",
      },
    });
  }

  if (normalizedAction === "show_more" || normalizedAction === "back") {
    return handleNavigationControl({
      username: safeUsername,
      action: normalizedAction === "show_more" ? "stage_next" : "stage_back",
      requestId,
      __deps: deps,
    });
  }

  if (normalizedAction === "compare" || normalizedAction === "go_deeper") {
    return handleNavigationControl({
      username: safeUsername,
      action: normalizedAction,
      requestId,
      __deps: deps,
    });
  }

  const activeBundleId = deps.getActiveBundleId?.(safeUsername);
  const bundle = activeBundleId ? await deps.getBundleById?.(activeBundleId) : await deps.loadActiveBundleForUser?.(safeUsername);
  if (!bundle?.bundleId) {
    return buildPendingResponse({
      requestId,
      voiceAnswer: "I don't have an active analysis yet. Ask a health question first.",
      reason: "missing_active_bundle",
      orchestrator: {
        controlAction: normalizedAction,
      },
    });
  }

  if (normalizedAction === "start_over") {
    const replay = replayStoredStage({
      bundle,
      stageIndex: 0,
      question: bundle.question || "",
      requestId,
    });
    if (!replay?.ok || !replay.stage) {
      deps.setRequestedStageIndex?.(safeUsername, 0);
      return buildPendingResponse({
        bundle,
        requestId,
        voiceAnswer: DEFAULT_PENDING_VOICE,
        activeStageIndex: bundle.currentStageIndex || 0,
        requestedStageIndex: 0,
        reason: "start_over_pending",
        orchestrator: {
          controlAction: normalizedAction,
        },
      });
    }
    await markActiveStage({
      deps,
      username: safeUsername,
      bundleId: bundle.bundleId,
      stageIndex: 0,
      requestKey: requestId || null,
    });
    return buildStageResult({
      bundle,
      stage: replay.stage,
      requestId,
      orchestrator: {
        controlAction: normalizedAction,
        stageGenerator: "replay_stored_stage",
      },
    });
  }

  const currentStage = getCurrentStage(bundle) || getLatestStage(bundle);
  const basePayload = buildStagePayload({
    bundle,
    stageRecord: currentStage,
    question: bundle.question || "",
    requestId,
  });
  const followupAnswer = await deps.answerFollowupFromPayload?.({
    payload: basePayload,
    question: normalizedAction === "summarize"
      ? "Overall, summarize what this chart means."
      : "Explain what this chart means.",
  });
  const payload = {
    ...basePayload,
    ...(followupAnswer?.payload || {}),
    answer_ready: true,
    voice_answer: followupAnswer?.payload?.voice_answer || followupAnswer?.answer || basePayload.voice_answer,
    spoken_answer: followupAnswer?.payload?.spoken_answer || followupAnswer?.answer || basePayload.spoken_answer,
  };
  return {
    ok: true,
    status: "ready",
    answerReady: true,
    answer_ready: true,
    voiceAnswer: payload.voice_answer,
    voice_answer: payload.voice_answer,
    requestId: requestId || payload.requestId || null,
    stageCount: Number(payload.stageCount || getPlannerStageCount(bundle)),
    activeStageIndex: Number(payload.activeStageIndex || bundle.currentStageIndex || 0),
    bundle_complete: Boolean(payload.bundle_complete),
    payload,
    stage: currentStage,
    bundleId: bundle.bundleId,
    orchestrator: {
      used: true,
      controlAction: normalizedAction,
      stageGenerator: "followup_answer",
    },
  };
}

async function handleQuestionWithOrchestrator(options = {}) {
  return startQuestionWithOrchestrator(options);
}

async function handleFollowupWithOrchestrator({
  username,
  question,
  requestId = null,
  __deps = null,
} = {}) {
  const normalized = String(question || "").trim().toLowerCase();
  if (["show more", "next", "more", "continue", "yes"].includes(normalized)) {
    return handleControlWithOrchestrator({ username, action: "show_more", requestId, __deps });
  }
  if (["go back", "back", "previous"].includes(normalized)) {
    return handleControlWithOrchestrator({ username, action: "back", requestId, __deps });
  }
  return startQuestionWithOrchestrator({
    username,
    question,
    requestId,
    requestSource: "followup",
    __deps,
  });
}

module.exports = {
  applyStageProgressionPolicy,
  buildCombinedVoiceAnswer,
  buildNarrationTimings,
  clearRuntimeState,
  fetchFitbitDataForBundle,
  handleControlWithOrchestrator,
  handleFollowupWithOrchestrator,
  handleNavigationControl,
  handleQuestionWithOrchestrator,
  startQuestionWithOrchestrator,
};
