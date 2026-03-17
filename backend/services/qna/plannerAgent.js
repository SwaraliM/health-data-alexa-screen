/**
 * backend/services/qna/plannerAgent.js
 *
 * Planner agent orchestration for Phase 2 shadow mode.
 * This layer stays lightweight and returns planner metadata for bundle storage.
 */

const { AGENT_CONFIGS } = require("../../configs/agentConfigs");
const { resolveRequestedMetrics } = require("../fitbit/metricResolver");
const { runPlannerRequest } = require("../openai/plannerClient");

const PLANNER_AGENT_DEBUG = process.env.QNA_PLANNER_AGENT_DEBUG !== "false";

function plannerAgentLog(message, data = null) {
  if (!PLANNER_AGENT_DEBUG) return;
  if (data == null) return console.log(`[PlannerAgent] ${message}`);
  console.log(`[PlannerAgent] ${message}`, data);
}

function sanitizeText(value, max = 160, fallback = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : fallback;
}

function toIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function buildCompactBundleSummary(activeBundle) {
  if (!activeBundle || typeof activeBundle !== "object") return null;

  const stages = Array.isArray(activeBundle.stages) ? activeBundle.stages : [];
  const plannerOutput = activeBundle.plannerOutput && typeof activeBundle.plannerOutput === "object"
    ? activeBundle.plannerOutput
    : {};

  return {
    bundleId: activeBundle.bundleId || null,
    username: activeBundle.username || null,
    status: activeBundle.status || null,
    question: sanitizeText(activeBundle.question, 180, ""),
    metricsRequested: Array.isArray(activeBundle.metricsRequested) ? activeBundle.metricsRequested.slice(0, 8) : [],
    timeScope: String(plannerOutput?.time_scope || plannerOutput?.timeScope || "").trim() || null,
    analysisGoal: sanitizeText(plannerOutput?.analysis_goal || plannerOutput?.analysisGoal, 160, ""),
    stageCount: stages.length,
    currentStageIndex: Number.isFinite(Number(activeBundle.currentStageIndex))
      ? Number(activeBundle.currentStageIndex)
      : 0,
    executorResponseId: activeBundle.executorResponseId || null,
    updatedAt: toIso(activeBundle.updatedAt),
  };
}

function fallbackPlannerResult({ question }) {
  const metrics = resolveRequestedMetrics(question);
  return {
    mode: "new_analysis",
    metricsNeeded: metrics,
    timeScope: "last_7_days",
    analysisGoal: sanitizeText(question, 140, "Summarize recent health trends"),
    candidateStageTypes: ["overview", "trend", "takeaway"],
    rawPlannerOutput: null,
    plannerVersion: AGENT_CONFIGS.planner.version,
    plannerMeta: {
      source: "fallback",
      reason: "planner_agent_error",
      responseId: null,
      responseStatus: "error",
    },
  };
}

function normalizePlannerMode(mode, hasActiveBundle) {
  const normalized = String(mode || "").trim().toLowerCase();
  if (["new_analysis", "continue_analysis", "branch_analysis"].includes(normalized)) {
    if (!hasActiveBundle && normalized !== "new_analysis") return "new_analysis";
    return normalized;
  }
  return hasActiveBundle ? "continue_analysis" : "new_analysis";
}

function normalizeStageTypes(stageTypes = []) {
  const values = Array.isArray(stageTypes) ? stageTypes : [stageTypes];
  const out = [];
  values.forEach((value) => {
    const normalized = String(value || "").trim().toLowerCase();
    if (!normalized) return;
    if (!out.includes(normalized)) out.push(normalized);
  });
  return out.length ? out : ["overview", "trend", "takeaway"];
}

async function planQuestion({ question, username, activeBundle = null, userContext = null } = {}) {
  const safeQuestion = sanitizeText(question, 320, "");
  const safeUsername = sanitizeText(username, 64, "").toLowerCase();
  const activeBundleSummary = buildCompactBundleSummary(activeBundle);

  plannerAgentLog("planning question", {
    username: safeUsername,
    hasActiveBundle: Boolean(activeBundleSummary),
    questionPreview: sanitizeText(safeQuestion, 100, ""),
  });

  try {
    const plan = await runPlannerRequest({
      question: safeQuestion,
      activeBundleSummary,
      userContext,
    });

    const normalizedMode = normalizePlannerMode(plan.mode, Boolean(activeBundleSummary));
    const normalizedMetrics = Array.isArray(plan.metrics_needed)
      ? plan.metrics_needed
      : resolveRequestedMetrics(plan.metrics_needed);

    return {
      mode: normalizedMode,
      metricsNeeded: normalizedMetrics,
      timeScope: sanitizeText(plan.time_scope, 40, "last_7_days"),
      analysisGoal: sanitizeText(plan.analysis_goal, 160, "Summarize recent health trends"),
      candidateStageTypes: normalizeStageTypes(plan.candidate_stage_types),
      rawPlannerOutput: plan.rawPlannerOutput || null,
      plannerVersion: AGENT_CONFIGS.planner.version,
      plannerMeta: {
        ...(plan.plannerMeta || {}),
        validatedMode: normalizedMode,
        timestamp: new Date().toISOString(),
      },
    };
  } catch (error) {
    plannerAgentLog("planner agent failed, fallback applied", {
      message: error?.message || String(error),
    });
    return fallbackPlannerResult({ question: safeQuestion });
  }
}

module.exports = {
  buildCompactBundleSummary,
  planQuestion,
};
