/**
 * backend/services/qna/plannerAgent.js
 *
 * V3-only planner — always returns sub_analyses[] + stages_plan[].
 * Uses runPlannerRequestV2 for query decomposition.
 */

"use strict";

const { AGENT_CONFIGS } = require("../../configs/agentConfigs");
const { resolveRequestedMetrics } = require("../fitbit/metricResolver");
const { runPlannerRequestV2 } = require("../openai/plannerClient");

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

function fallbackPlannerResult({ question, enrichedIntent }) {
  const metrics = resolveRequestedMetrics(question);
  const timeScope = sanitizeText(enrichedIntent?.time_range, 40, "last_7_days") || "last_7_days";
  return {
    metricsNeeded: metrics,
    timeScope,
    analysisGoal: sanitizeText(enrichedIntent?.rich_analysis_goal || question, 140, "Summarize recent health trends"),
    candidateStageTypes: ["overview", "trend", "takeaway"],
    stagesPlan: [
      { stageIndex: 0, stageType: "overview", stageRole: "primary", focusMetrics: metrics.slice(0, 4), chartType: "bar", title: "", goal: "" },
      { stageIndex: 1, stageType: "trend", stageRole: "deep_dive", focusMetrics: metrics.slice(0, 4), chartType: "line", title: "", goal: "" },
      { stageIndex: 2, stageType: "takeaway", stageRole: "summary", focusMetrics: metrics.slice(0, 4), chartType: "list_summary", title: "", goal: "" },
    ],
    subAnalyses: [{
      id: "sa_primary",
      label: sanitizeText(enrichedIntent?.rich_analysis_goal || question, 140, ""),
      metrics_needed: metrics,
      time_scope: timeScope,
      analysis_type: "primary",
    }],
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

/**
 * Plan a fresh question. Always returns stagesPlan + subAnalyses.
 *
 * @param {object} opts
 * @param {string} opts.question
 * @param {string} opts.username
 * @param {object} [opts.enrichedIntent]
 * @param {object} [opts.userContext]
 * @param {string[]} [opts.forcedMetrics]
 */
async function planQuestion({ question, username, enrichedIntent = null, userContext = null, forcedMetrics = null } = {}) {
  const safeQuestion = sanitizeText(question, 320, "");
  const safeUsername = sanitizeText(username, 64, "").toLowerCase();

  plannerAgentLog("planning question", {
    username: safeUsername,
    questionPreview: sanitizeText(safeQuestion, 100, ""),
    inferredMetrics: enrichedIntent?.inferred_metrics,
    timeRange: enrichedIntent?.time_range,
  });

  try {
    const plan = await runPlannerRequestV2({
      question: safeQuestion,
      enrichedIntent,
      userContext,
      forcedMetrics: Array.isArray(forcedMetrics) && forcedMetrics.length ? forcedMetrics : null,
    });

    const normalizedMetrics = Array.isArray(plan.metrics_needed || plan.metricsNeeded)
      ? (plan.metrics_needed || plan.metricsNeeded)
      : resolveRequestedMetrics(plan.metrics_needed);

    const stagesPlan = Array.isArray(plan.stages_plan || plan.stagesPlan) && (plan.stages_plan || plan.stagesPlan).length
      ? (plan.stages_plan || plan.stagesPlan)
      : fallbackPlannerResult({ question: safeQuestion, enrichedIntent }).stagesPlan;

    const result = {
      metricsNeeded: normalizedMetrics,
      timeScope: sanitizeText(plan.time_scope || plan.timeScope, 40, "last_7_days"),
      analysisGoal: sanitizeText(plan.analysis_goal || plan.analysisGoal, 160, "Summarize recent health trends"),
      candidateStageTypes: normalizeStageTypes(plan.candidate_stage_types || plan.candidateStageTypes),
      stagesPlan,
      rawPlannerOutput: plan.rawPlannerOutput || null,
      plannerVersion: plan.plannerMeta?.plannerVersion || AGENT_CONFIGS.planner.version,
      plannerMeta: {
        ...(plan.plannerMeta || {}),
        timestamp: new Date().toISOString(),
      },
    };

    // Propagate sub_analyses if present
    if (Array.isArray(plan.sub_analyses || plan.subAnalyses) && (plan.sub_analyses || plan.subAnalyses).length) {
      result.subAnalyses = plan.sub_analyses || plan.subAnalyses;
    }

    return result;
  } catch (error) {
    plannerAgentLog("planner agent failed, fallback applied", {
      message: error?.message || String(error),
    });
    return fallbackPlannerResult({ question: safeQuestion, enrichedIntent });
  }
}

module.exports = {
  planQuestion,
};
