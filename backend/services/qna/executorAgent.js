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

/**
 * Merge a GPT response (text fills + selected_strategy_id) with the
 * strategy-built chart data to produce a stageOutput compatible with
 * normalizeExecutorStageOutput.
 */
function mergeStrategyResponse(gptOutput, viableStrategies, multiWindowData, evidenceBundle) {
  if (!gptOutput || !Array.isArray(viableStrategies) || !viableStrategies.length) {
    return gptOutput;
  }

  const selectedId = String(gptOutput.selected_strategy_id || "").trim();
  const matched = viableStrategies.find((s) => s.strategy_id === selectedId);
  const strategy = matched || viableStrategies[0];

  agentLog("strategy selected", {
    selectedId: selectedId || "(none)",
    resolvedId: strategy?.strategy_id,
    chart_type: strategy?.chart_type || "unknown",
  });

  // Build chart data deterministically from the selected strategy
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
  };
}

/**
 * Generate a single stage.
 * V3 path only: evidence-based strategy selection.
 */
async function generateStageFromExecutor({
  bundle,
  question,
  stageIndex,
  userContext = null,
  stageSpec = null,
  requestId = null,
  multiWindowData = null,
  evidenceBundle = null,
} = {}) {
  if (!bundle || typeof bundle !== "object") {
    return { ok: false, error: "generateStageFromExecutor requires bundle", stage: null };
  }

  const safeStageIndex = Math.max(0, Number(stageIndex) || 0);
  const safeQuestion = sanitizeText(question, 360, "");

  // Generate viable chart strategies from data + evidence
  let viableStrategies = null;
  try {
    const previousChartTypes = Array.isArray(bundle.stages)
      ? bundle.stages.map((s) => s?.chartSpec?.chart_type || s?.metadata?.executor?.selectedChartType).filter(Boolean)
      : [];
    viableStrategies = generateViableStrategies({
      stageSpec: stageSpec || {},
      multiWindowData: multiWindowData || {},
      evidenceBundle: evidenceBundle || {},
      previousChartTypes,
    });
    if (Array.isArray(viableStrategies) && !viableStrategies.length) viableStrategies = null;
  } catch (err) {
    agentLog("strategy generation failed", {
      stageIndex: safeStageIndex,
      error: String(err?.message || err),
    });
    viableStrategies = null;
  }

  if (!viableStrategies) {
    return { ok: false, error: "No viable chart strategies generated", stage: null };
  }

  agentLog("generating stage", {
    bundleId: bundle.bundleId || null,
    stageIndex: safeStageIndex,
    strategyCount: viableStrategies.length,
  });

  const executorInput = {
    bundleSummary: buildBundleSummary(bundle, evidenceBundle),
    stageHistory: buildCompactStageHistory(bundle?.stages),
    question: safeQuestion,
    previousResponseId: null,
    userContext: userContext || null,
    stageIndex: safeStageIndex,
    stageSpec: stageSpec || null,
    templateCandidates: null,
    viableStrategies,
    evidenceBundle,
    toolContext: null,
  };

  const response = await runExecutorRequest(executorInput);

  if (!response?.ok || !response?.stageOutput) {
    return {
      ok: false,
      error: response?.error || "Executor stage generation failed",
      stage: null,
    };
  }

  // Merge GPT text fills with deterministic chart data
  const resolvedStageOutput = mergeStrategyResponse(
    response.stageOutput, viableStrategies, multiWindowData, evidenceBundle,
  );

  const stage = normalizeExecutorStageOutput({
    executorOutput: resolvedStageOutput,
    stageIndex: safeStageIndex,
    requestId,
    question: safeQuestion,
    source: "executor_agent",
    fallbackTitle: `Insight stage ${safeStageIndex + 1}`,
  });

  stage.metadata = {
    ...(stage.metadata || {}),
    executor: {
      responseId: response.responseId || null,
      responseStatus: response.status || "completed",
      stageIndex: safeStageIndex,
      path: "v3_evidence_strategy",
      strategyCount: viableStrategies.length,
      selectedChartType: resolvedStageOutput?.chart_spec?.chart_type || null,
      selectedStrategyId: response.stageOutput?.selected_strategy_id || null,
    },
  };

  return {
    ok: true,
    stage,
    executorResponseId: response.responseId || null,
  };
}

/**
 * Generate all N stages in parallel using Promise.all.
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

  agentLog("generating all stages in parallel", {
    bundleId: bundle?.bundleId || null,
    stageCount: stagesPlan.length,
  });

  const stagePromises = stagesPlan.map((stageSpec) => {
    const stageIndex = Number(stageSpec?.stageIndex ?? 0);
    return generateStageFromExecutor({
      bundle,
      question,
      stageIndex,
      userContext,
      stageSpec,
      requestId,
      multiWindowData,
      evidenceBundle,
    });
  });

  const results = await Promise.all(stagePromises);

  const stages = [];
  const errors = [];

  results.forEach((result, i) => {
    if (result?.ok && result?.stage) {
      // Set moreAvailable based on position in the plan
      result.stage.moreAvailable = i < stagesPlan.length - 1;
      stages.push(result.stage);
    } else {
      errors.push(result?.error || `Stage ${i} failed`);
      agentLog("stage generation failed", { stageIndex: i, error: result?.error });
    }
  });

  stages.sort((a, b) => (a.stageIndex ?? 0) - (b.stageIndex ?? 0));

  agentLog("all stages completed", {
    total: stagesPlan.length,
    succeeded: stages.length,
    failed: errors.length,
  });

  return {
    ok: stages.length > 0,
    stages,
    errors,
  };
}

module.exports = {
  buildBundleSummary,
  generateStageFromExecutor,
  generateAllStages,
  mergeStrategyResponse,
};
