/**
 * backend/services/qna/executorAgent.js
 *
 * V3-only executor — generates all N chart stages in parallel via Promise.all.
 * Uses evidence-based strategy selection (chartStrategyService).
 * GPT picks a strategy + fills text; chart data is built deterministically.
 */

"use strict";

const { runExecutorRequest } = require("../openai/executorClient");
const { normalizeExecutorStageOutput } = require("./stageService");
const { generateViableStrategies, buildChartFromStrategy } = require("../charts/chartStrategyService");

const EXECUTOR_AGENT_DEBUG = process.env.QNA_EXECUTOR_AGENT_DEBUG !== "false";

function agentLog(message, data = null) {
  if (!EXECUTOR_AGENT_DEBUG) return;
  if (data == null) return console.log(`[ExecutorAgent] ${message}`);
  console.log(`[ExecutorAgent] ${message}`, data);
}

function sanitizeText(value, max = 180, fallback = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : fallback;
}

function buildCompactStageHistory(stages = []) {
  return (Array.isArray(stages) ? stages : [])
    .slice(-6)
    .map((stage) => ({
      stageIndex: Number(stage?.stageIndex || 0),
      title: sanitizeText(stage?.title, 120, ""),
      spokenText: sanitizeText(stage?.spokenText, 260, ""),
      screenText: sanitizeText(stage?.screenText, 260, ""),
      suggestedFollowups: Array.isArray(stage?.suggestedFollowups) ? stage.suggestedFollowups.slice(0, 4) : [],
      moreAvailable: false,
    }));
}

/**
 * Build a compact bundle summary for the executor, using evidence instead of raw rows.
 */
function buildBundleSummary(bundle = null, evidenceBundle = null) {
  const source = bundle && typeof bundle === "object" ? bundle : {};
  const plannerOutput = source.plannerOutput && typeof source.plannerOutput === "object"
    ? source.plannerOutput
    : {};

  return {
    bundleId: source.bundleId || null,
    username: source.username || null,
    status: source.status || null,
    experienceMode: "voice_first_all_charts",
    question: sanitizeText(source.question, 260, ""),
    planner: {
      time_scope: String(plannerOutput?.time_scope || plannerOutput?.timeScope || "").trim() || null,
      analysis_goal: sanitizeText(plannerOutput?.analysis_goal || plannerOutput?.analysisGoal, 160, ""),
      candidate_stage_types: Array.isArray(plannerOutput?.candidate_stage_types)
        ? plannerOutput.candidate_stage_types.slice(0, 8)
        : Array.isArray(plannerOutput?.candidateStageTypes)
          ? plannerOutput.candidateStageTypes.slice(0, 8)
          : [],
    },
    metricsRequested: Array.isArray(source.metricsRequested) ? source.metricsRequested.slice(0, 8) : [],
    evidenceSummary: evidenceBundle || null,
    currentStageIndex: Number(source.currentStageIndex || 0),
    stageCount: Array.isArray(source.stages) ? source.stages.length : 0,
    updatedAt: source.updatedAt || null,
  };
}

function mergeStrategyResponse(gptOutput, viableStrategies, multiWindowData, evidenceBundle) {
  if (!gptOutput || !Array.isArray(viableStrategies) || !viableStrategies.length) {
    return { stageOutput: gptOutput, strategy: null };
  }

  const selectedId = String(gptOutput.selected_strategy_id || "").trim();
  const matched = viableStrategies.find((s) => s.strategy_id === selectedId);
  const strategy = matched || viableStrategies[0];

  agentLog("strategy selected", {
    selectedId: selectedId || "(none)",
    resolvedId: strategy?.strategy_id,
    chart_type: strategy?.chart_type || "unknown",
  });

  let chartData = null;
  try {
    chartData = buildChartFromStrategy(
      strategy.strategy_id,
      multiWindowData || {},
      evidenceBundle || {},
      viableStrategies,
    );
  } catch (err) {
    agentLog("buildChartFromStrategy failed, using fallback", {
      error: String(err?.message || err),
    });
  }

  return {
    strategy,
    stageOutput: {
      title:               gptOutput.title || "",
      spoken_text:         gptOutput.spoken_text || "",
      screen_text:         gptOutput.screen_text || "",
      suggested_followups: gptOutput.suggested_followups || [],
      more_available:      gptOutput.more_available,
      continuation_hint:   "",
      analysis_notes:      gptOutput.analysis_notes || "",
      chart_spec: {
        chart_type: chartData?.chart_type || strategy.chart_type || "bar",
        title:      gptOutput.chart_title || strategy.description || "",
        subtitle:   gptOutput.chart_subtitle || "",
        takeaway:   gptOutput.chart_takeaway || "",
        chart_data: chartData?.chart_data || null,
      },
    },
  };
}

function buildBundleCandidates(stagesPlan = [], multiWindowData = {}, evidenceBundle = {}) {
  const allChartTypeHints = (Array.isArray(stagesPlan) ? stagesPlan : [])
    .map((spec) => String(spec?.chartType || "").toLowerCase().trim())
    .filter(Boolean);

  return (Array.isArray(stagesPlan) ? stagesPlan : []).map((stageSpec, i) => {
    const otherStageHints = allChartTypeHints.filter((_, idx) => idx !== i);
    const viableStrategies = generateViableStrategies({
      stageSpec: stageSpec || {},
      multiWindowData: multiWindowData || {},
      evidenceBundle: evidenceBundle || {},
      previousChartTypes: otherStageHints,
    });

    return {
      stage_index: Number(stageSpec?.stageIndex ?? i),
      title_hint: stageSpec?.title || `Insight stage ${i + 1}`,
      narrative_role_hint: i === 0 ? "orientation" : i === (stagesPlan.length - 1) ? "takeaway" : "deepening",
      chart_type_hint: stageSpec?.chartType || "",
      focus_metrics: Array.isArray(stageSpec?.focusMetrics) ? stageSpec.focusMetrics.slice(0, 8) : [],
      goal: stageSpec?.goal || "",
      visualization_intent: stageSpec?.visualization_intent || stageSpec?.stageType || "",
      viable_strategies: Array.isArray(viableStrategies) ? viableStrategies : [],
      stage_spec: stageSpec || {},
    };
  });
}

function buildFallbackStage(stageIndex, totalStages, question, requestId) {
  return normalizeExecutorStageOutput({
    executorOutput: {
      title: `Insight stage ${stageIndex + 1}`,
      spoken_text: stageIndex === totalStages - 1
        ? "I was able to prepare part of your answer, but not the final section."
        : "I wasn't able to generate this section clearly, so I am moving to the next chart.",
      screen_text: "Section unavailable.",
      suggested_followups: ["explain that"],
      more_available: stageIndex < totalStages - 1,
      analysis_notes: "bundle_generation_fallback",
      chart_spec: null,
    },
    stageIndex,
    requestId,
    question,
    source: "executor_agent_fallback",
    fallbackTitle: `Insight stage ${stageIndex + 1}`,
  });
}

function normalizeAuthoredBundleStages({
  bundleOutput = null,
  bundleCandidates = [],
  question = "",
  requestId = null,
  responseId = null,
  responseStatus = "completed",
  multiWindowData = null,
  evidenceBundle = null,
} = {}) {
  const safeQuestion = sanitizeText(question, 360, "");
  const authoredStages = Array.isArray(bundleOutput?.stages) ? bundleOutput.stages : [];
  const candidateMap = new Map(bundleCandidates.map((candidate) => [Number(candidate.stage_index || 0), candidate]));
  const totalStages = bundleCandidates.length || authoredStages.length || 1;
  const stages = [];
  const errors = [];

  for (let idx = 0; idx < totalStages; idx++) {
    const authored = authoredStages.find((stage) => Number(stage?.stage_index || 0) === idx) || null;
    const candidate = candidateMap.get(idx) || null;
    const viableStrategies = Array.isArray(candidate?.viable_strategies) ? candidate.viable_strategies : [];

    if (!authored || !viableStrategies.length) {
      stages.push(buildFallbackStage(idx, totalStages, safeQuestion, requestId));
      if (!authored) errors.push(`Missing authored stage ${idx}`);
      else errors.push(`No viable strategies for stage ${idx}`);
      continue;
    }

    const merged = mergeStrategyResponse(authored, viableStrategies, multiWindowData, evidenceBundle);
    const stage = normalizeExecutorStageOutput({
      executorOutput: {
        ...merged.stageOutput,
        more_available: idx < totalStages - 1,
      },
      stageIndex: idx,
      requestId,
      question: safeQuestion,
      source: "executor_agent",
      fallbackTitle: candidate?.title_hint || `Insight stage ${idx + 1}`,
    });

    stage.metadata = {
      ...(stage.metadata || {}),
      bundleThread: sanitizeText(bundleOutput?.bundle_thread, 320, ""),
      bundleSummary: sanitizeText(bundleOutput?.bundle_summary, 320, ""),
      narrativeRole: sanitizeText(authored?.narrative_role, 60, ""),
      stageMetrics: Array.isArray(merged?.strategy?.metrics) ? merged.strategy.metrics.slice(0, 8) : [],
      executor: {
        ...((stage.metadata && stage.metadata.executor) || {}),
        responseId: responseId || null,
        responseStatus,
        stageIndex: idx,
        path: "v3_bundle_authoring",
        strategyCount: viableStrategies.length,
        selectedChartType: merged?.stageOutput?.chart_spec?.chart_type || null,
        selectedStrategyId: authored?.selected_strategy_id || null,
      },
    };

    stages.push(stage);
  }

  stages.sort((a, b) => (a.stageIndex ?? 0) - (b.stageIndex ?? 0));
  return { stages, errors };
}

/**
 * Generate all stages as one authored bundle.
 */
async function generateAllStages({
  bundle,
  question,
  stagesPlan,
  userContext = null,
  requestId = null,
  multiWindowData = null,
  evidenceBundle = null,
} = {}) {
  if (!Array.isArray(stagesPlan) || !stagesPlan.length) {
    return { ok: false, stages: [], errors: ["stagesPlan is empty"] };
  }

  agentLog("generating authored bundle", {
    bundleId: bundle?.bundleId || null,
    stageCount: stagesPlan.length,
  });

  let bundleCandidates;
  try {
    bundleCandidates = buildBundleCandidates(stagesPlan, multiWindowData || {}, evidenceBundle || {});
  } catch (error) {
    return {
      ok: false,
      stages: [],
      errors: [String(error?.message || error)],
    };
  }

  if (!bundleCandidates.length || bundleCandidates.some((candidate) => !candidate.viable_strategies?.length)) {
    return {
      ok: false,
      stages: [],
      errors: ["Failed to build viable chart strategies for one or more stages"],
    };
  }

  const response = await runExecutorRequest({
    bundleSummary: buildBundleSummary(bundle, evidenceBundle),
    stageHistory: buildCompactStageHistory(bundle?.stages),
    question: sanitizeText(question, 360, ""),
    previousResponseId: null,
    userContext: userContext || null,
    stageIndex: 0,
    bundleCandidates,
    evidenceBundle,
    toolContext: null,
  });

  if (!response?.ok || !response?.bundleOutput) {
    return {
      ok: false,
      stages: [],
      errors: [response?.error || "Executor bundle generation failed"],
    };
  }

  const normalized = normalizeAuthoredBundleStages({
    bundleOutput: response.bundleOutput,
    bundleCandidates,
    question,
    requestId,
    responseId: response.responseId || null,
    responseStatus: response.status || "completed",
    multiWindowData,
    evidenceBundle,
  });

  agentLog("authored bundle completed", {
    total: stagesPlan.length,
    produced: normalized.stages.length,
    failed: normalized.errors.length,
  });

  return {
    ok: normalized.stages.length > 0,
    stages: normalized.stages,
    errors: normalized.errors,
  };
}

module.exports = {
  buildBundleSummary,
  buildBundleCandidates,
  generateAllStages,
  mergeStrategyResponse,
};
