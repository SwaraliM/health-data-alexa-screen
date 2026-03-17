/**
 * backend/services/openai/plannerClient.js
 *
 * Thin planner-specific wrapper around the generic Responses API client.
 * It sanitizes model output so invalid planner JSON never breaks runtime.
 */

const {
  AGENT_CONFIGS,
  PLANNER_ALLOWED_MODES,
  PLANNER_ALLOWED_STAGE_TYPES,
  PLANNER_ALLOWED_TIME_SCOPES,
} = require("../../configs/agentConfigs");
const { resolveRequestedMetrics } = require("../fitbit/metricResolver");
const { createResponse } = require("./responsesClient");

const PLANNER_DEBUG = process.env.QNA_PLANNER_DEBUG !== "false";

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

function detectModeFallback(question = "", activeBundleSummary = null) {
  if (!activeBundleSummary) return "new_analysis";
  const q = String(question || "").toLowerCase();
  if (/\binstead\b|\banother\b|\bnew\b|\bdifferent\b|\balso show\b/.test(q)) return "branch_analysis";
  return "continue_analysis";
}

function sanitizeMode(mode, fallback) {
  const normalized = String(mode || "").trim().toLowerCase();
  return PLANNER_ALLOWED_MODES.includes(normalized) ? normalized : fallback;
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

function buildFallbackPlan({ question, activeBundleSummary }) {
  const mode = detectModeFallback(question, activeBundleSummary);
  const inheritedMetrics = Array.isArray(activeBundleSummary?.metricsRequested)
    ? activeBundleSummary.metricsRequested
    : [];
  const resolverMetrics = resolveRequestedMetrics(question);
  const heuristicMetrics = heuristicMetricsFromQuestion(question);
  const metrics = [...new Set([...inheritedMetrics, ...heuristicMetrics, ...resolverMetrics])].slice(0, 6);
  const timeScope = detectTimeScopeFallback(question, activeBundleSummary?.timeScope || "last_7_days");
  const analysisGoal = sanitizeText(question, 140, "Summarize recent health trends");
  const candidateStageTypes = fallbackStageTypes(metrics);

  return {
    mode,
    metrics_needed: metrics,
    time_scope: timeScope,
    analysis_goal: analysisGoal,
    candidate_stage_types: candidateStageTypes,
  };
}

function normalizePlannerOutput(raw, fallback) {
  const source = raw && typeof raw === "object" ? raw : {};
  const mode = sanitizeMode(source.mode, fallback.mode);
  const metrics = resolveRequestedMetrics(source.metrics_needed || source.metrics || fallback.metrics_needed);
  const timeScope = sanitizeTimeScope(source.time_scope, fallback.time_scope);
  const analysisGoal = sanitizeText(source.analysis_goal, 160, fallback.analysis_goal);
  const candidateStageTypes = sanitizeStageTypes(source.candidate_stage_types, fallback.candidate_stage_types);

  return {
    mode,
    metrics_needed: metrics,
    time_scope: timeScope,
    analysis_goal: analysisGoal,
    candidate_stage_types: candidateStageTypes,
  };
}

async function runPlannerRequest({ question, activeBundleSummary = null, userContext = null } = {}) {
  const plannerConfig = AGENT_CONFIGS.planner;
  const fallbackPlan = buildFallbackPlan({ question, activeBundleSummary });

  const plannerInput = {
    question: sanitizeText(question, 300, ""),
    active_bundle_summary: activeBundleSummary || null,
    user_context: userContext || null,
    allowed_modes: plannerConfig.allowedModes,
    allowed_time_scopes: plannerConfig.allowedTimeScopes,
    allowed_stage_types: plannerConfig.allowedStageTypes,
  };

  const response = await createResponse({
    model: plannerConfig.model,
    input: plannerInput,
    instructions: plannerConfig.systemPrompt,
    responseFormat: plannerConfig.textFormat,
    tools: [],
    timeoutMs: plannerConfig.timeoutMs,
    temperature: plannerConfig.temperature,
    maxOutputTokens: plannerConfig.maxOutputTokens,
    metadata: {
      agent: "planner",
      version: plannerConfig.version,
      username: sanitizeText(activeBundleSummary?.username, 32, ""),
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
  const normalized = normalizePlannerOutput(rawOutput, fallbackPlan);
  const usedFallback = !rawOutput;

  plannerLog("planner request completed", {
    responseId: response.responseId,
    usedFallback,
    mode: normalized.mode,
    metrics: normalized.metrics_needed,
    time_scope: normalized.time_scope,
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
