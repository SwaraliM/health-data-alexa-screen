/**
 * backend/services/openai/plannerClient.js
 *
 * Thin planner-specific wrapper around the generic Responses API client.
 * It sanitizes model output so invalid planner JSON never breaks runtime.
 */

const {
  AGENT_CONFIGS,
  ENHANCED_PLANNER_SYSTEM_PROMPT,
  EXECUTOR_ALLOWED_CHART_TYPES,
  PLANNER_ALLOWED_STAGE_TYPES,
  PLANNER_ALLOWED_TIME_SCOPES,
} = require("../../configs/agentConfigs");

const { resolveRequestedMetrics } = require("../fitbit/metricResolver");
const { createResponse } = require("./responsesClient");

const PLANNER_DEBUG = process.env.QNA_PLANNER_DEBUG !== "false";
const EXECUTOR_MAX_STAGE_COUNT = Math.max(
  1,
  Math.floor(Number(AGENT_CONFIGS.executor?.progression?.maxStages || 4))
);
const ALLOWED_STAGE_ROLES = ["primary", "comparison", "deep_dive", "summary"];

function plannerLog(message, data = null) {
  if (!PLANNER_DEBUG) return;
  if (data == null) return console.log(`[PlannerClient] ${message}`);
  console.log(`[PlannerClient] ${message}`, data);
}

function sanitizeText(value, max = 180, fallback = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : fallback;
}

function detectTimeScopeFallback(question = "", defaultScope = "last_7_days") {
  const q = String(question || "").toLowerCase();
  if (/today|this morning|this afternoon|this evening/.test(q)) return "today";
  if (/yesterday/.test(q)) return "yesterday";
  if (/last night/.test(q)) return "last_night";
  if (/this week/.test(q)) return "this_week";
  if (/last week/.test(q)) return "last_week";
  if (/30 days|month/.test(q)) return "last_30_days";
  return defaultScope;
}

function sanitizeTimeScope(scope, fallback) {
  const normalized = String(scope || "").trim().toLowerCase();
  return PLANNER_ALLOWED_TIME_SCOPES.includes(normalized) ? normalized : fallback;
}

function sanitizeStageTypes(types, fallback = []) {
  const list = Array.isArray(types) ? types : [types];
  const out = [];
  list.forEach((item) => {
    const normalized = String(item || "").trim().toLowerCase();
    if (!normalized) return;
    if (PLANNER_ALLOWED_STAGE_TYPES.includes(normalized) && !out.includes(normalized)) {
      out.push(normalized);
    }
  });
  return out.length ? out : fallback;
}

function fallbackStageTypes(metrics = []) {
  const list = Array.isArray(metrics) ? metrics : [];
  const defaults = ["overview", "trend", "takeaway"];
  if (list.length > 1) defaults.push("comparison");
  if (list.some((metric) => String(metric).includes("intraday"))) defaults.push("relationship");
  if (list.some((metric) => ["resting_hr", "hrv"].includes(String(metric)))) defaults.push("relationship");
  return [...new Set(defaults)];
}

function heuristicMetricsFromQuestion(question = "") {
  const q = String(question || "").toLowerCase();
  const metrics = [];
  const push = (metric) => {
    if (metric && !metrics.includes(metric)) metrics.push(metric);
  };

  if (/sleep|slept|bed|wake|night/.test(q)) push("sleep_minutes");
  if (/hrv|variability|recovery/.test(q)) push("hrv");
  if (/resting heart|resting hr|heart rate|pulse|bpm/.test(q)) push("resting_hr");
  if (/calories|burn/.test(q)) push("calories");
  if (/distance|mile|km|kilometer/.test(q)) push("distance");
  if (/stairs|floors/.test(q)) push("floors");
  if (/elevation|climb/.test(q)) push("elevation");
  if (/steps|walk|activity|movement/.test(q)) push("steps");

  if (/by hour|hourly|intraday|through the day|today over time/.test(q)) {
    if (metrics.includes("steps")) push("steps_intraday");
    else if (metrics.includes("calories")) push("calories_intraday");
    else if (metrics.includes("distance")) push("distance_intraday");
    else if (metrics.includes("floors")) push("floors_intraday");
    else if (metrics.includes("resting_hr")) push("heart_intraday");
    else push("steps_intraday");
  }

  if (!metrics.length) push("steps");
  return metrics;
}

const STAGE_TYPE_TO_CHART_TYPE = {
  overview: "bar",
  sleep_stages: "stacked_bar",
  trend: "line",
  respiratory_health: "line",
  relationship: "grouped_bar",
  takeaway: "list_summary",
  comparison: "grouped_bar",
  anomaly: "line",
  goal_progress: "gauge",
  intraday_breakdown: "area",
  sleep_detail: "stacked_bar",
  heart_recovery: "line",
};

function sanitizeStagePlan(rawPlan, maxStages) {
  if (!Array.isArray(rawPlan)) return null;
  const valid = [];
  for (const entry of rawPlan) {
    if (!entry || typeof entry !== "object") continue;
    const stageIndex = Math.floor(Number(entry.stageIndex));
    if (!Number.isFinite(stageIndex) || stageIndex < 0) continue;
    const stageType = String(entry.stageType || "").trim().toLowerCase();
    if (!PLANNER_ALLOWED_STAGE_TYPES.includes(stageType)) continue;
    const chartType = String(entry.chartType || "").trim().toLowerCase();
    if (!EXECUTOR_ALLOWED_CHART_TYPES.includes(chartType)) continue;
    const focusMetrics = Array.isArray(entry.focusMetrics)
      ? entry.focusMetrics.map((m) => String(m || "").trim()).filter(Boolean).slice(0, 6)
      : [];
    const title = sanitizeText(entry.title, 100, "");
    const goal = sanitizeText(entry.goal, 180, "");
    const requestedRole = String(entry.stageRole || "").trim().toLowerCase();
    const stageRole = ALLOWED_STAGE_ROLES.includes(requestedRole)
      ? requestedRole
      : (stageIndex === 0 ? "primary" : (stageType === "comparison" ? "comparison" : "deep_dive"));
    valid.push({ stageIndex, stageType, stageRole, focusMetrics, chartType, title, goal });
  }
  if (valid.length < 1) return null;
  valid.sort((a, b) => a.stageIndex - b.stageIndex);
  // Re-index from 0
  valid.forEach((s, i) => {
    s.stageIndex = i;
    if (i === 0) s.stageRole = "primary";
    else if (i === valid.length - 1 && s.stageRole !== "comparison") s.stageRole = s.stageRole === "deep_dive" ? "deep_dive" : "summary";
  });
  return valid.slice(0, maxStages);
}

function buildFallbackStagesPlan(metrics, candidateStageTypes) {
  const stageTypes = Array.isArray(candidateStageTypes) && candidateStageTypes.length
    ? candidateStageTypes
    : ["overview", "trend", "takeaway"];
  const limited = stageTypes.slice(0, EXECUTOR_MAX_STAGE_COUNT);
  return limited.map((stageType, idx) => ({
    stageIndex: idx,
    stageType,
    stageRole: idx === 0
      ? "primary"
      : stageType === "comparison"
        ? "comparison"
        : idx === limited.length - 1
          ? "summary"
          : "deep_dive",
    focusMetrics: Array.isArray(metrics) ? metrics.slice(0, 4) : [],
    chartType: STAGE_TYPE_TO_CHART_TYPE[stageType] || "bar",
    title: "",
    goal: "",
  }));
}

function buildFallbackPlan({ question, enrichedIntent = null }) {
  const inheritedMetrics = Array.isArray(enrichedIntent?.inferred_metrics)
    ? enrichedIntent.inferred_metrics
    : [];
  const resolverMetrics = resolveRequestedMetrics(question);
  const heuristicMetrics = heuristicMetricsFromQuestion(question);
  const metrics = [...new Set([...inheritedMetrics, ...heuristicMetrics, ...resolverMetrics])].slice(0, 6);
  const timeScope = sanitizeTimeScope(enrichedIntent?.time_range, null)
    || detectTimeScopeFallback(question, "last_7_days");
  const analysisGoal = sanitizeText(enrichedIntent?.rich_analysis_goal || question, 140, "Summarize recent health trends");
  const candidateStageTypes = fallbackStageTypes(metrics);
  const stages_plan = buildFallbackStagesPlan(metrics, candidateStageTypes);

  return {
    metrics_needed: metrics,
    time_scope: timeScope,
    analysis_goal: analysisGoal,
    candidate_stage_types: candidateStageTypes,
    stages_plan,
  };
}

function normalizePlannerOutput(raw, fallback, forcedMetrics = null) {
  const source = raw && typeof raw === "object" ? raw : {};
  const baseMetrics = resolveRequestedMetrics(source.metrics_needed || source.metrics || fallback.metrics_needed);
  const metrics = Array.isArray(forcedMetrics) && forcedMetrics.length
    ? resolveRequestedMetrics([...forcedMetrics, ...baseMetrics])
    : baseMetrics;
  const timeScope = sanitizeTimeScope(source.time_scope, fallback.time_scope);
  const analysisGoal = sanitizeText(source.analysis_goal, 160, fallback.analysis_goal);
  const candidateStageTypes = sanitizeStageTypes(source.candidate_stage_types, fallback.candidate_stage_types);
  const stages_plan = sanitizeStagePlan(source.stages_plan, EXECUTOR_MAX_STAGE_COUNT)
    || buildFallbackStagesPlan(metrics, candidateStageTypes);

  return {
    metrics_needed: metrics,
    time_scope: timeScope,
    analysis_goal: analysisGoal,
    candidate_stage_types: candidateStageTypes,
    stages_plan,
  };
}

async function runPlannerRequest({ question, enrichedIntent = null, userContext = null, forcedMetrics = null } = {}) {
  const plannerConfig = AGENT_CONFIGS.planner;
  const fallbackPlan = buildFallbackPlan({ question, enrichedIntent });

  const plannerInput = {
    question: sanitizeText(question, 300, ""),
    inferred_metrics: Array.isArray(enrichedIntent?.inferred_metrics) ? enrichedIntent.inferred_metrics : [],
    rich_analysis_goal: sanitizeText(enrichedIntent?.rich_analysis_goal, 300, ""),
    time_range: sanitizeText(enrichedIntent?.time_range, 40, "last_7_days") || "last_7_days",
    user_context: userContext || null,
    allowed_time_scopes: plannerConfig.allowedTimeScopes,
    allowed_stage_types: plannerConfig.allowedStageTypes,
    forced_metrics: Array.isArray(forcedMetrics) && forcedMetrics.length ? forcedMetrics : null,
  };

  const response = await createResponse({
    model: plannerConfig.model,
    input: plannerInput,
    instructions: ENHANCED_PLANNER_SYSTEM_PROMPT,
    responseFormat: plannerConfig.textFormat,
    tools: [],
    timeoutMs: plannerConfig.timeoutMs,
    temperature: plannerConfig.temperature,
    maxOutputTokens: plannerConfig.maxOutputTokens,
    metadata: {
      agent: "planner",
      version: plannerConfig.version,
    },
  });

  if (!response?.ok) {
    plannerLog("planner request failed, using fallback", {
      status: response?.status || "unknown",
      error: response?.error || "",
    });
    return {
      ...fallbackPlan,
      rawPlannerOutput: null,
      plannerMeta: {
        source: "fallback",
        responseStatus: response?.status || "error",
        responseId: null,
      },
    };
  }

  const rawOutput = response.outputJson || null;
  const normalized = normalizePlannerOutput(rawOutput, fallbackPlan, forcedMetrics);
  const usedFallback = !rawOutput;

  plannerLog("planner request completed", {
    responseId: response.responseId,
    usedFallback,
    metrics: normalized.metrics_needed,
    time_scope: normalized.time_scope,
    stageCount: normalized.stages_plan?.length,
  });

  return {
    ...normalized,
    rawPlannerOutput: rawOutput || fallbackPlan,
    plannerMeta: {
      source: usedFallback ? "fallback" : "gpt",
      responseStatus: response.status || "completed",
      responseId: response.responseId || null,
    },
  };
}

module.exports = {
  runPlannerRequest,
};
