/**
 * backend/services/qna/executorAgent.js
 *
 * Parallel executor — generates all N chart stages simultaneously via Promise.all.
 * V2 template-fill path only (no legacy V1).
 */

const { runExecutorRequest } = require("../openai/executorClient");
const { normalizeExecutorStageOutput } = require("./stageService");
const { buildTemplatesForStage } = require("../charts/chartTemplateBuilder");

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

function compactNormalizedTable(bundle = null, maxRows = 180) {
  const rows = Array.isArray(bundle?.normalizedTable) ? bundle.normalizedTable : [];
  return rows.slice(-Math.max(20, Number(maxRows) || 180));
}

function buildBundleSummary(bundle = null) {
  const source = bundle && typeof bundle === "object" ? bundle : {};
  const plannerOutput = source.plannerOutput && typeof source.plannerOutput === "object"
    ? source.plannerOutput
    : {};

  const normalizedRows = compactNormalizedTable(source, 180);
  const firstRow = normalizedRows[0] || {};
  const metricColumns = Object.keys(firstRow).filter((key) => key !== "timestamp");

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
    normalizedTableColumns: metricColumns,
    normalizedTableRowCount: normalizedRows.length,
    normalizedTableRows: normalizedRows,
    rawCacheKeys: source.rawFitbitCache && typeof source.rawFitbitCache === "object"
      ? Object.keys(source.rawFitbitCache).slice(0, 12)
      : [],
    currentStageIndex: Number(source.currentStageIndex || 0),
    stageCount: Array.isArray(source.stages) ? source.stages.length : 0,
    updatedAt: source.updatedAt || null,
  };
}

/**
 * Merge a V2 GPT response (text fills + selected_template_index) with the
 * pre-built template candidate to produce a stageOutput compatible with
 * normalizeExecutorStageOutput.
 */
function mergeV2ResponseWithTemplate(v2Output, templateCandidates) {
  if (!v2Output || !Array.isArray(templateCandidates) || !templateCandidates.length) {
    return v2Output;
  }
  const rawIndex = Number(v2Output.selected_template_index);
  const safeIndex = Number.isFinite(rawIndex)
    ? Math.max(0, Math.min(templateCandidates.length - 1, rawIndex))
    : 0;
  const selectedTemplate = templateCandidates[safeIndex] || templateCandidates[0];

  agentLog("v2 template selected", {
    selectedIndex: safeIndex,
    chart_type: selectedTemplate?.chart_type || "unknown",
  });

  return {
    title:               v2Output.title || "",
    spoken_text:         v2Output.spoken_text || "",
    screen_text:         v2Output.screen_text || "",
    suggested_followups: v2Output.suggested_followups || [],
    // Stage reveal progression is decided by the planner/coordinator, not by executor prose.
    more_available:      v2Output.more_available,
    continuation_hint:   "",
    analysis_notes:      v2Output.analysis_notes || "",
    chart_spec: {
      chart_type: selectedTemplate.chart_type,
      title:      v2Output.chart_title || selectedTemplate.description || "",
      subtitle:   v2Output.chart_subtitle || "",
      takeaway:   v2Output.chart_takeaway || "",
      chart_data: selectedTemplate.chart_data,
    },
  };
}

/**
 * Generate a single stage (internal worker for Promise.all).
 */
async function generateStageFromExecutor({
  bundle,
  question,
  stageIndex,
  userContext = null,
  stageSpec = null,
  requestId = null,
} = {}) {
  if (!bundle || typeof bundle !== "object") {
    return { ok: false, error: "generateStageFromExecutor requires bundle", stage: null };
  }

  const safeStageIndex = Math.max(0, Number(stageIndex) || 0);
  const safeQuestion = sanitizeText(question, 360, "");

  // Build V2 template candidates
  let templateCandidates = null;
  try {
    templateCandidates = buildTemplatesForStage({
      normalizedTable: bundle.normalizedTable,
      plannerOutput: bundle.plannerOutput,
      stageIndex: safeStageIndex,
      previousStageTypes: Array.isArray(bundle.stages)
        ? bundle.stages.map((s) => s?.metadata?.stageType).filter(Boolean)
        : [],
      rawFitbitCache: bundle.rawFitbitCache || null,
      stageSpec: stageSpec || null,
    });
    if (Array.isArray(templateCandidates) && !templateCandidates.length) templateCandidates = null;
  } catch (templateErr) {
    agentLog("template build failed for stage", {
      stageIndex: safeStageIndex,
      error: String(templateErr?.message || templateErr),
    });
    templateCandidates = null;
  }

  agentLog("generating stage", {
    bundleId: bundle.bundleId || null,
    stageIndex: safeStageIndex,
    hasTemplates: Boolean(templateCandidates),
    templateCount: templateCandidates?.length || 0,
  });

  const executorInput = {
    bundleSummary: buildBundleSummary(bundle),
    stageHistory: buildCompactStageHistory(bundle?.stages),
    question: safeQuestion,
    previousResponseId: null, // parallel — no chaining
    userContext: userContext || null,
    stageIndex: safeStageIndex,
    stageSpec: stageSpec || null,
    templateCandidates: templateCandidates || null,
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

  const resolvedStageOutput = templateCandidates
    ? mergeV2ResponseWithTemplate(response.stageOutput, templateCandidates)
    : response.stageOutput;

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
      path: "v2_template_fill",
      templateCount: templateCandidates ? templateCandidates.length : 0,
      selectedChartType: resolvedStageOutput?.chart_spec?.chart_type || null,
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
 *
 * @param {object} opts
 * @param {object} opts.bundle - QnaBundle document with normalizedTable, plannerOutput, etc.
 * @param {string} opts.question - User question
 * @param {Array}  opts.stagesPlan - Planner output: array of { stageIndex, stageType, focusMetrics, chartType, title, goal }
 * @param {object} [opts.userContext]
 * @param {string} [opts.requestId]
 * @returns {Promise<{ ok: boolean, stages: object[], errors: string[] }>}
 */
async function generateAllStages({ bundle, question, stagesPlan, userContext = null, requestId = null } = {}) {
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
    });
  });

  const results = await Promise.all(stagePromises);

  const stages = [];
  const errors = [];

  results.forEach((result, i) => {
    if (result?.ok && result?.stage) {
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
  mergeV2ResponseWithTemplate,
};
