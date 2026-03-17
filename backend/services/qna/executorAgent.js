/**
 * backend/services/qna/executorAgent.js
 *
 * Phase 4 executor stage generation.
 *
 * Design goals:
 * - generate exactly one stage per request
 * - keep backend logic lightweight (no heavy analytics engine)
 * - let GPT infer/calculations happen from normalized Fitbit table rows
 * - return stage records in the shared stage format
 */

const { runExecutorRequest } = require("../openai/executorClient");
const {
  getNextStageIndex,
  normalizeExecutorStageOutput,
} = require("./stageService");
const { buildTemplatesForStage } = require("../charts/chartTemplateBuilder");

// V2 template-fill path: enabled by default, matches executorClient flag.
const USE_TEMPLATE_FILL_EXECUTOR =
  process.env.USE_TEMPLATE_FILL_EXECUTOR !== "false";

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

function pickPlannerField(plannerOutput = {}, keys = []) {
  const source = plannerOutput && typeof plannerOutput === "object" ? plannerOutput : {};
  for (const key of keys) {
    if (source[key] != null && String(source[key]).trim()) return source[key];
  }
  return null;
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
      moreAvailable: Boolean(stage?.moreAvailable),
    }));
}

/**
 * We send only a bounded slice of normalized rows to keep latency predictable.
 * The full table stays in Mongo bundle memory.
 */
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
    experienceMode: "voice_first_single_chart",
    question: sanitizeText(source.question, 260, ""),
    parentBundleId: source.parentBundleId || null,
    planner: {
      mode: pickPlannerField(plannerOutput, ["mode"]),
      time_scope: pickPlannerField(plannerOutput, ["time_scope", "timeScope"]),
      analysis_goal: pickPlannerField(plannerOutput, ["analysis_goal", "analysisGoal"]),
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
    executorResponseId: source.executorResponseId || null,
    updatedAt: source.updatedAt || null,
  };
}

function buildExecutorInputFromBundle({
  bundle,
  question,
  stageIndex = 0,
  previousResponseId = null,
  userContext = null,
} = {}) {
  return {
    bundleSummary: buildBundleSummary(bundle),
    stageHistory: buildCompactStageHistory(bundle?.stages),
    question: sanitizeText(question, 360, ""),
    previousResponseId: previousResponseId || bundle?.executorResponseId || null,
    userContext: userContext || null,
    stageIndex: Math.max(0, Number(stageIndex) || 0),
  };
}

function determineRequestedStage({
  bundle = null,
  requestedStageIndex = null,
  mode = "auto",
} = {}) {
  const normalizedMode = String(mode || "auto").toLowerCase();
  const hasRequestedIndex = requestedStageIndex != null && requestedStageIndex !== "";
  const explicitIndex = hasRequestedIndex ? Math.max(0, Number(requestedStageIndex) || 0) : null;

  if (normalizedMode === "initial") {
    return {
      stageIndex: 0,
      generationType: "initial",
      reason: "forced_initial",
    };
  }

  if (normalizedMode === "next") {
    return {
      stageIndex: explicitIndex == null ? getNextStageIndex(bundle) : explicitIndex,
      generationType: "next",
      reason: explicitIndex == null ? "next_stage_auto" : "next_stage_requested",
    };
  }

  if (explicitIndex != null) {
    const stageCount = Array.isArray(bundle?.stages) ? bundle.stages.length : 0;
    return {
      stageIndex: explicitIndex,
      generationType: explicitIndex <= 0 && stageCount === 0 ? "initial" : "next",
      reason: "requested_stage_index",
    };
  }

  const stageCount = Array.isArray(bundle?.stages) ? bundle.stages.length : 0;
  if (!stageCount) {
    return {
      stageIndex: 0,
      generationType: "initial",
      reason: "empty_bundle",
    };
  }

  return {
    stageIndex: getNextStageIndex(bundle),
    generationType: "next",
    reason: "auto_next",
  };
}

/**
 * Merge a V2 GPT response (text fills + selected_template_index) with the
 * pre-built template candidate to produce a stageOutput compatible with
 * normalizeExecutorStageOutput (same shape as V1 executor output).
 *
 * The merged object has chart_spec.chart_data already populated by the backend,
 * so hydrateChartSpec will route cleanly through chartPresetLibrary builders.
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
    description: selectedTemplate?.description || "",
  });

  return {
    title:               v2Output.title || "",
    spoken_text:         v2Output.spoken_text || "",
    screen_text:         v2Output.screen_text || "",
    suggested_followups: v2Output.suggested_followups || [],
    more_available:      Boolean(v2Output.more_available),
    continuation_hint:   v2Output.continuation_hint || "",
    analysis_notes:      v2Output.analysis_notes || "",
    // Synthesize chart_spec: backend data + GPT text labels
    chart_spec: {
      chart_type: selectedTemplate.chart_type,
      title:      v2Output.chart_title || selectedTemplate.description || "",
      subtitle:   v2Output.chart_subtitle || "",
      takeaway:   v2Output.chart_takeaway || "",
      chart_data: selectedTemplate.chart_data,
      // No "option" field here — hydrateChartSpec will build it from chart_data
    },
  };
}

async function generateStageFromExecutor({
  bundle,
  question,
  stageIndex,
  previousResponseId = null,
  userContext = null,
  voiceDeadlineMs = 4200,
  requestId = null,
  source = "executor_agent",
  toolContext = null,
} = {}) {
  if (!bundle || typeof bundle !== "object") {
    return {
      ok: false,
      error: "generateStageFromExecutor requires bundle",
      stage: null,
      executorResponseId: null,
    };
  }

  const requested = determineRequestedStage({
    bundle,
    requestedStageIndex: stageIndex,
    mode: "auto",
  });
  const safeStageIndex = Math.max(0, Number(requested.stageIndex) || 0);
  const executorInput = buildExecutorInputFromBundle({
    bundle,
    question,
    stageIndex: safeStageIndex,
    previousResponseId,
    userContext,
  });
  const safeQuestion = executorInput.question;

  // ── V2: Build template candidates before calling GPT ──────────────────────
  let templateCandidates = null;
  if (USE_TEMPLATE_FILL_EXECUTOR) {
    try {
      templateCandidates = buildTemplatesForStage({
        normalizedTable: bundle.normalizedTable,
        plannerOutput: bundle.plannerOutput,
        stageIndex: safeStageIndex,
        previousStageTypes: Array.isArray(bundle.stages)
          ? bundle.stages.map((s) => s?.metadata?.stageType).filter(Boolean)
          : [],
        rawFitbitCache: bundle.rawFitbitCache || null,
      });
      agentLog("v2 template candidates built", {
        count: templateCandidates.length,
        types: templateCandidates.map((c) => c.chart_type),
        stageIndex: safeStageIndex,
      });
    } catch (templateErr) {
      agentLog("v2 template build failed → falling back to v1", {
        error: String(templateErr?.message || templateErr),
      });
      templateCandidates = null;
    }
    // If template build returned nothing, fall back to v1 (avoids empty prompt)
    if (Array.isArray(templateCandidates) && !templateCandidates.length) {
      agentLog("v2 template candidates empty → falling back to v1");
      templateCandidates = null;
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  agentLog("generating stage via executor", {
    bundleId: bundle.bundleId || null,
    stageIndex: safeStageIndex,
    generationType: requested.generationType,
    path: templateCandidates ? "v2_template_fill" : "v1_legacy",
    stageHistoryCount: executorInput.stageHistory.length,
    hasPreviousResponseId: Boolean(executorInput.previousResponseId),
    previousResponseId: executorInput.previousResponseId || null,
  });

  const response = await runExecutorRequest({
    ...executorInput,
    voiceDeadlineMs,
    // V2 uses template-fill path (no tools, simpler schema)
    templateCandidates: templateCandidates || null,
    // V1 keeps tool context for backwards compatibility
    toolContext: templateCandidates ? null : {
      bundle,
      userContext: userContext || null,
      ...(toolContext || {}),
    },
  });

  if (!response?.ok || !response?.stageOutput) {
    return {
      ok: false,
      error: response?.error || "Executor stage generation failed",
      status: response?.status || "error",
      stage: null,
      executorResponseId: response?.responseId || null,
      executor: {
        toolEvents: response?.toolEvents || [],
      },
    };
  }

  // ── V2: Merge template data with GPT text fills ────────────────────────────
  const resolvedStageOutput = templateCandidates
    ? mergeV2ResponseWithTemplate(response.stageOutput, templateCandidates)
    : response.stageOutput;
  // ─────────────────────────────────────────────────────────────────────────

  const stage = normalizeExecutorStageOutput({
    executorOutput: resolvedStageOutput,
    stageIndex: safeStageIndex,
    requestId,
    question: safeQuestion,
    source,
    fallbackTitle: `Insight stage ${safeStageIndex + 1}`,
  });

  stage.metadata = {
    ...(stage.metadata || {}),
    executor: {
      ...(stage.metadata?.executor || {}),
      responseId: response.responseId || null,
      responseStatus: response.status || "completed",
      toolEvents: response.toolEvents || [],
      stageIndex: safeStageIndex,
      // V2 path tracking for debugging
      path: templateCandidates ? "v2_template_fill" : "v1_legacy",
      templateCount: templateCandidates ? templateCandidates.length : 0,
      selectedChartType: templateCandidates
        ? (resolvedStageOutput?.chart_spec?.chart_type || null)
        : null,
    },
  };

  return {
    ok: true,
    status: response.status || "completed",
    error: null,
    stage,
    executorResponseId: response.responseId || null,
    executor: {
      responseId: response.responseId || null,
      toolEvents: response.toolEvents || [],
      outputText: response.outputText || "",
    },
  };
}

async function generateInitialStage({
  bundle,
  question,
  previousResponseId = null,
  userContext = null,
  voiceDeadlineMs = 4200,
  requestId = null,
  toolContext = null,
} = {}) {
  return generateStageFromExecutor({
    bundle,
    question,
    stageIndex: 0,
    previousResponseId,
    userContext,
    voiceDeadlineMs,
    requestId,
    source: "executor_stage1",
    toolContext,
  });
}

async function generateNextStage({
  bundle,
  question,
  stageIndex = null,
  previousResponseId = null,
  userContext = null,
  voiceDeadlineMs = 4200,
  requestId = null,
  toolContext = null,
} = {}) {
  const requested = determineRequestedStage({
    bundle,
    requestedStageIndex: stageIndex,
    mode: "next",
  });
  const resolvedStageIndex = requested.stageIndex;

  return generateStageFromExecutor({
    bundle,
    question,
    stageIndex: resolvedStageIndex,
    previousResponseId: previousResponseId || bundle?.executorResponseId || null,
    userContext,
    voiceDeadlineMs,
    requestId,
    source: "executor_stage_next",
    toolContext,
  });
}

module.exports = {
  buildExecutorInputFromBundle,
  buildBundleSummary,
  determineRequestedStage,
  generateInitialStage,
  generateNextStage,
  generateStageFromExecutor,
  mergeV2ResponseWithTemplate,
};
