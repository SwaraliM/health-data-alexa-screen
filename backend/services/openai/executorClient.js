/**
 * backend/services/openai/executorClient.js
 *
 * Phase 4 executor wrapper around Responses API.
 * - stage-oriented request/response envelope
 * - supports previous_response_id chaining
 * - supports lightweight tool loop
 * - keeps logging compact and failure-safe
 */

const { AGENT_CONFIGS } = require("../../configs/agentConfigs");

// V2 template-fill path is enabled by default.
// Set USE_TEMPLATE_FILL_EXECUTOR=false to fall back to V1 for all requests.
const USE_TEMPLATE_FILL_EXECUTOR =
  process.env.USE_TEMPLATE_FILL_EXECUTOR !== "false";
const { createResponse } = require("./responsesClient");
const { getExecutorTools, runToolLoop } = require("./toolLoop");

const EXECUTOR_DEBUG = process.env.QNA_EXECUTOR_DEBUG !== "false";

function executorLog(message, data = null) {
  if (!EXECUTOR_DEBUG) return;
  if (data == null) return console.log(`[ExecutorClient] ${message}`);
  console.log(`[ExecutorClient] ${message}`, data);
}

function sanitizeText(value, max = 180, fallback = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : fallback;
}

function asNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildStringMetadata({
  version = "",
  stageIndex = 0,
  bundleId = null,
  username = "",
} = {}) {
  const metadata = {
    agent: "executor",
    version: sanitizeText(version, 64, "executor"),
    stage_index: String(Math.max(0, Number(stageIndex) || 0)),
  };
  const safeBundleId = sanitizeText(bundleId, 120, "");
  const safeUsername = sanitizeText(username, 64, "");
  if (safeBundleId) metadata.bundle_id = safeBundleId;
  if (safeUsername) metadata.username = safeUsername;
  return metadata;
}

function safeJsonParse(value) {
  if (!value || typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_) {
    return null;
  }
}

function resolveTimeoutMs(configTimeoutMs, voiceDeadlineMs) {
  const configMs = configTimeoutMs == null || configTimeoutMs === 0 ? null : asNumber(configTimeoutMs, null);
  if (configMs == null || configMs <= 0) return null;
  const voiceMs = asNumber(voiceDeadlineMs, null);
  if (voiceMs == null || voiceMs <= 0) return configMs;
  // Leave margin for orchestration + payload mapping before Alexa poll response.
  return Math.max(1200, Math.min(configMs, voiceMs - 350));
}

/**
 * Build the user message input for the V2 template-fill executor path.
 *
 * The key difference from V1: includes template_candidates so GPT only needs
 * to pick a template index and fill text fields — no chart data to generate.
 *
 * @param {object} opts
 * @param {object|null} opts.bundleSummary
 * @param {object[]}   opts.stageHistory
 * @param {string}     opts.question
 * @param {object|null} opts.userContext
 * @param {number}     opts.stageIndex
 * @param {{ index, chart_type, description, chart_data }[]} opts.templateCandidates
 */
function buildExecutorInputV2({
  bundleSummary = null,
  stageHistory = [],
  question = "",
  userContext = null,
  stageIndex = 0,
  templateCandidates = [],
  stageSpec = null,
} = {}) {
  const compactHistory = (Array.isArray(stageHistory) ? stageHistory : [])
    .slice(-4)
    .map((stage) => ({
      stageIndex: Number(stage?.stageIndex || 0),
      title: sanitizeText(stage?.title, 120, ""),
      spokenText: sanitizeText(stage?.spokenText, 200, ""),
      moreAvailable: Boolean(stage?.moreAvailable),
    }));

  // Send a compact summary — GPT does not need the full normalized table in V2
  // because the chart data is already in template_candidates.
  const compactBundleSummary = bundleSummary ? {
    bundleId: bundleSummary.bundleId || null,
    username: bundleSummary.username || null,
    question: sanitizeText(bundleSummary.question, 360, ""),
    planner: bundleSummary.planner || null,
    metricsRequested: Array.isArray(bundleSummary.metricsRequested)
      ? bundleSummary.metricsRequested.slice(0, 8)
      : [],
    currentStageIndex: bundleSummary.currentStageIndex || 0,
    stageCount: bundleSummary.stageCount || 0,
    // Omit normalizedTableRows — data is in template_candidates
  } : null;

  return {
    question: sanitizeText(question, 360, ""),
    requested_stage_index: Math.max(0, Number(stageIndex) || 0),
    bundle_summary: compactBundleSummary,
    stage_history: compactHistory,
    user_context: userContext || null,
    template_candidates: Array.isArray(templateCandidates) ? templateCandidates : [],
    stage_specification: stageSpec ? {
      stageType: stageSpec.stageType,
      focusMetrics: stageSpec.focusMetrics || [],
      chartType: stageSpec.chartType,
      title: stageSpec.title,
      goal: stageSpec.goal,
    } : null,
    instructions: {
      pick_template_index: "Choose selected_template_index from the template_candidates list (0-based).",
      fill_text_only: "You only write text fields. The chart data in the selected template is already correct.",
      use_stage_spec: stageSpec
        ? `This is stage type '${stageSpec.stageType}', focusing on [${(stageSpec.focusMetrics || []).join(", ")}]. Prefer chart type '${stageSpec.chartType}'. Goal: ${stageSpec.goal}`
        : "Choose the best template based on available data.",
      voice_formula: [
        "spoken_text sentence 1: Orientation — describe what the chart shows.",
        "spoken_text sentence 2-3: Highlight — what stands out, in plain words.",
        "spoken_text sentence 4: Meaning — what this tells the user about their health.",
        "spoken_text sentence 5 (if more_available): Invite continuation — 'Say show more to continue.'",
      ],
      style: "Warm, plain-language, older-adult-friendly. No jargon. No long number lists.",
    },
  };
}

function buildExecutorInput({
  bundleSummary = null,
  stageHistory = [],
  question = "",
  userContext = null,
  stageIndex = 0,
} = {}) {
  const compactHistory = (Array.isArray(stageHistory) ? stageHistory : [])
    .slice(-4)
    .map((stage) => ({
      stageIndex: Number(stage?.stageIndex || 0),
      title: sanitizeText(stage?.title, 120, ""),
      spokenText: sanitizeText(stage?.spokenText, 240, ""),
      screenText: sanitizeText(stage?.screenText, 240, ""),
      moreAvailable: Boolean(stage?.moreAvailable),
    }));

  return {
    question: sanitizeText(question, 360, ""),
    requested_stage_index: Math.max(0, Number(stageIndex) || 0),
    bundle_summary: bundleSummary || null,
    stage_history: compactHistory,
    user_context: userContext || null,
    constraints: {
      one_stage_only: true,
      no_raw_ui_code: true,
      chart_spec_target: "echarts_json_spec",
      narration_style: "older_adult_friendly_voice_guide",
      narration_required_sections: [
        "what_is_on_screen",
        "what_stands_out",
        "what_it_means",
      ],
      preferred_visual_words: ["bars", "line", "points", "up", "down", "steady", "more", "less"],
      suggested_followup_style: "voice_command_phrase",
      example_voice_commands: [
        "show more",
        "next",
        "go back",
        "explain that",
        "compare that",
        "what does this mean",
        "start over",
      ],
    },
  };
}

/**
 * Build the user message input for the V3 evidence-strategy executor path.
 *
 * Key difference from V2: GPT receives pre-computed evidence (not raw rows or templates)
 * and a list of viable_strategies (not template_candidates). GPT picks a strategy_id.
 */
function buildExecutorInputV3({
  bundleSummary = null,
  stageHistory = [],
  question = "",
  userContext = null,
  stageIndex = 0,
  evidenceBundle = null,
  viableStrategies = [],
  stageSpec = null,
} = {}) {
  const compactHistory = (Array.isArray(stageHistory) ? stageHistory : [])
    .slice(-4)
    .map((stage) => ({
      stageIndex: Number(stage?.stageIndex || 0),
      title: sanitizeText(stage?.title, 120, ""),
      spokenText: sanitizeText(stage?.spokenText, 200, ""),
      moreAvailable: Boolean(stage?.moreAvailable),
    }));

  const compactBundleSummary = bundleSummary ? {
    bundleId: bundleSummary.bundleId || null,
    username: bundleSummary.username || null,
    question: sanitizeText(bundleSummary.question, 360, ""),
    planner: bundleSummary.planner || null,
    metricsRequested: Array.isArray(bundleSummary.metricsRequested)
      ? bundleSummary.metricsRequested.slice(0, 8) : [],
    currentStageIndex: bundleSummary.currentStageIndex || 0,
    stageCount: bundleSummary.stageCount || 0,
  } : null;

  return {
    question: sanitizeText(question, 360, ""),
    requested_stage_index: Math.max(0, Number(stageIndex) || 0),
    bundle_summary: compactBundleSummary,
    stage_history: compactHistory,
    user_context: userContext || null,
    evidence: evidenceBundle || null,
    viable_strategies: Array.isArray(viableStrategies) ? viableStrategies.map((s) => ({
      strategy_id: s.strategy_id,
      chart_type: s.chart_type,
      description: s.description,
    })) : [],
    stage_specification: stageSpec ? {
      visualization_intent: stageSpec.visualization_intent || stageSpec.stageType || "",
      focusMetrics: stageSpec.focusMetrics || [],
      chartType: stageSpec.chartType,
      title: stageSpec.title,
      goal: stageSpec.goal,
    } : null,
    instructions: {
      pick_strategy: "Choose selected_strategy_id from the viable_strategies list.",
      use_evidence: "Use the pre-computed evidence (means, trends, anomalies, correlations, deltas) to inform your narration. Do NOT do arithmetic — the evidence already has the numbers.",
      fill_text_only: "You only write text fields. The backend builds chart data from your selected strategy.",
      voice_formula: [
        "spoken_text sentence 1: Orientation — describe what the chart shows.",
        "spoken_text sentence 2: Highlight — what stands out from the evidence.",
        "spoken_text sentence 3: Meaning — what this tells the user about their health.",
        "spoken_text sentence 4 (FINAL stage only, evaluative questions): Verdict — direct answer starting with 'So to summarize', 'In short', or 'The bottom line'.",
      ],
      conversational_verdict: "For yes/no or evaluative questions (worse, better, enough, normal, unusual, worsened, improved), end spoken_text on the FINAL stage with a verdict sentence: 'So to summarize — [answer]', 'In short — [verdict]', or 'The bottom line — [conclusion]'. Example: 'So to summarize — your sleep has actually stayed fairly average this week, no real decline.'",
      anomaly_narration: "When evidence contains anomaly_summary: if all_clear is true, reassure warmly ('Everything looks normal this week'). If flagged_metrics exist, narrate the top 1-2 findings with gentle context. Never alarm — always frame anomalies as observations, not diagnoses.",
      report_narration: "When evidence contains health_scorecard, structure narration around it: lead with the highest-scoring metric ('Your [metric] looks great'), then mention any area needing attention. Always frame constructively.",
      style: "Warm, plain-language, older-adult-friendly. No jargon. No long number lists.",
    },
  };
}

function buildExecutorBundleInputV3({
  bundleSummary = null,
  question = "",
  userContext = null,
  evidenceBundle = null,
  bundleCandidates = [],
} = {}) {
  const compactBundleSummary = bundleSummary ? {
    bundleId: bundleSummary.bundleId || null,
    username: bundleSummary.username || null,
    question: sanitizeText(bundleSummary.question, 360, ""),
    planner: bundleSummary.planner || null,
    metricsRequested: Array.isArray(bundleSummary.metricsRequested)
      ? bundleSummary.metricsRequested.slice(0, 8) : [],
    currentStageIndex: bundleSummary.currentStageIndex || 0,
    stageCount: bundleSummary.stageCount || 0,
  } : null;

  return {
    question: sanitizeText(question, 360, ""),
    bundle_summary: compactBundleSummary,
    user_context: userContext || null,
    evidence: evidenceBundle || null,
    bundle_candidates: Array.isArray(bundleCandidates) ? bundleCandidates.map((candidate) => ({
      stage_index: Math.max(0, Number(candidate?.stage_index || candidate?.stageIndex || 0)),
      title_hint: sanitizeText(candidate?.title_hint || candidate?.titleHint || candidate?.title, 120, ""),
      narrative_role_hint: sanitizeText(candidate?.narrative_role_hint || candidate?.narrativeRoleHint || "", 60, ""),
      chart_type_hint: sanitizeText(candidate?.chart_type_hint || candidate?.chartTypeHint || "", 40, ""),
      focus_metrics: Array.isArray(candidate?.focus_metrics || candidate?.focusMetrics)
        ? (candidate.focus_metrics || candidate.focusMetrics).slice(0, 8)
        : [],
      goal: sanitizeText(candidate?.goal, 180, ""),
      visualization_intent: sanitizeText(candidate?.visualization_intent || candidate?.visualizationIntent, 180, ""),
      viable_strategies: Array.isArray(candidate?.viable_strategies || candidate?.viableStrategies)
        ? (candidate.viable_strategies || candidate.viableStrategies).map((s) => ({
            strategy_id: s.strategy_id,
            chart_type: s.chart_type,
            description: s.description,
            metrics: Array.isArray(s.metrics) ? s.metrics.slice(0, 8) : [],
          }))
        : [],
    })) : [],
    instructions: {
      author_bundle: "Author the whole chart sequence as one coherent answer, then return ordered stages.",
      keep_syncable: "Each stage must stand on its own when spoken alongside its chart, but all stages should feel like one answer.",
      direct_verdict: "For evaluative questions, the final stage must explicitly answer the question in plain language.",
      inference_required: "Each stage must go beyond describing the chart: include an inference from the evidence and explain why the metric matters.",
      metric_explanation: "Briefly explain the current metric in plain language, not just what the visual looks like.",
    },
  };
}

function extractResponseId(response = {}) {
  return response?.responseId
    || response?.id
    || response?.data?.id
    || response?.data?.response?.id
    || response?.raw?.id
    || null;
}

function extractToolCallsFromRaw(raw = null) {
  const output = Array.isArray(raw?.output) ? raw.output : [];
  return output.filter((item) => {
    const type = String(item?.type || "").toLowerCase();
    return type === "function_call" || type === "tool_call";
  });
}

function extractToolCalls(response = {}) {
  const fromResponse = Array.isArray(response?.toolCalls) ? response.toolCalls : [];
  if (fromResponse.length) return fromResponse;
  const fromRaw = extractToolCallsFromRaw(response?.raw || response?.data || null);
  if (fromRaw.length) return fromRaw;
  return [];
}

function extractTextFromRaw(raw = null) {
  if (typeof raw?.output_text === "string" && raw.output_text.trim()) {
    return raw.output_text.trim();
  }
  const chunks = [];
  const output = Array.isArray(raw?.output) ? raw.output : [];
  output.forEach((item) => {
    if (typeof item?.text === "string" && item.text.trim()) chunks.push(item.text.trim());
    const content = Array.isArray(item?.content) ? item.content : [];
    content.forEach((part) => {
      if (typeof part?.text === "string" && part.text.trim()) chunks.push(part.text.trim());
      if (typeof part?.output_text === "string" && part.output_text.trim()) chunks.push(part.output_text.trim());
    });
  });
  return chunks.join("\n").trim();
}

function extractExecutorOutput(response = {}) {
  if (response?.outputJson && typeof response.outputJson === "object") {
    return response.outputJson;
  }
  const textCandidates = [
    response?.outputText || "",
    extractTextFromRaw(response?.data || null),
    extractTextFromRaw(response?.raw || null),
  ];
  for (const candidate of textCandidates) {
    const parsed = safeJsonParse(candidate);
    if (parsed && typeof parsed === "object") return parsed;
  }
  return null;
}

function normalizeExecutorResponse(response = {}) {
  const executorOutput = extractExecutorOutput(response);
  const responseId = extractResponseId(response);
  const toolCalls = extractToolCalls(response);
  const toolEvents = response?.toolEvents || [];
  const outputText = response?.outputText || extractTextFromRaw(response?.data || null) || "";

  if (!response?.ok) {
    return {
      ok: false,
      status: response?.status || "error",
      error: response?.error || "executor request failed",
      responseId,
      previousResponseId: responseId,
      bundleOutput: null,
      stageOutput: null,
      toolCalls,
      toolEvents,
      raw: response?.data || null,
      outputText,
    };
  }

  if (!executorOutput) {
    return {
      ok: false,
      status: "invalid_output",
      error: "Executor did not return valid structured JSON",
      responseId,
      previousResponseId: responseId,
      bundleOutput: null,
      stageOutput: null,
      toolCalls,
      toolEvents,
      raw: response?.data || null,
      outputText,
    };
  }

  return {
    ok: true,
    status: response?.status || "completed",
    error: null,
    responseId,
    previousResponseId: responseId,
    bundleOutput: Array.isArray(executorOutput?.stages) ? executorOutput : null,
    stageOutput: Array.isArray(executorOutput?.stages) ? null : executorOutput,
    toolCalls,
    toolEvents,
    raw: response?.data || null,
    outputText,
  };
}

async function runExecutorRequest({
  bundleSummary = null,
  stageHistory = [],
  question = "",
  previousResponseId = null,
  userContext = null,
  stageIndex = 0,
  stageSpec = null,
  voiceDeadlineMs = null,
  toolContext = null,
  templateCandidates = null,  // V2: pre-built chart templates from chartTemplateBuilder
  viableStrategies = null,    // V3: strategies from chartStrategyService
  bundleCandidates = null,    // V3 bundle authoring: per-stage candidate strategies
  evidenceBundle = null,      // V3: pre-computed evidence from evidenceComputer
  __deps = null,
} = {}) {
  const deps = __deps && typeof __deps === "object" ? __deps : {};

  // Select path: V3 bundle authoring > V3 stage authoring > V2 template-fill > V1 legacy
  const hasBundleCandidates = Array.isArray(bundleCandidates) && bundleCandidates.length > 0;
  const hasStrategies = !hasBundleCandidates && Array.isArray(viableStrategies) && viableStrategies.length > 0;
  const hasTemplates = !hasBundleCandidates && !hasStrategies
    && USE_TEMPLATE_FILL_EXECUTOR
    && Array.isArray(templateCandidates)
    && templateCandidates.length > 0;

  const config = deps.config || (
    hasBundleCandidates || hasStrategies ? AGENT_CONFIGS.executorV3
    : hasTemplates ? AGENT_CONFIGS.executorV2
    : AGENT_CONFIGS.executor
  );
  const createResponseFn = deps.createResponse || createResponse;
  const getExecutorToolsFn = deps.getExecutorTools || getExecutorTools;
  const runToolLoopFn = deps.runToolLoop || runToolLoop;

  const timeoutMs = resolveTimeoutMs(config.timeoutMs, voiceDeadlineMs);
  // V2/V3 have no tools; V1 retains its tool loop
  const tools = (hasTemplates || hasStrategies || hasBundleCandidates) ? [] : getExecutorToolsFn(config.toolPolicy || null);
  const hasTools = Array.isArray(tools) && tools.length > 0;

  const input = hasBundleCandidates
    ? buildExecutorBundleInputV3({
        bundleSummary,
        question,
        userContext,
        evidenceBundle,
        bundleCandidates,
      })
    : hasStrategies
    ? buildExecutorInputV3({
        bundleSummary,
        stageHistory,
        question,
        userContext,
        stageIndex,
        evidenceBundle,
        viableStrategies,
        stageSpec: stageSpec || null,
      })
    : hasTemplates
      ? buildExecutorInputV2({
          bundleSummary,
          stageHistory,
          question,
          userContext,
          stageIndex,
          templateCandidates,
          stageSpec: stageSpec || null,
        })
      : buildExecutorInput({
          bundleSummary,
          stageHistory,
          question,
          userContext,
          stageIndex,
        });

  const baseRequest = {
    model: config.model,
    input,
    instructions: config.systemPrompt,
    responseFormat: config.textFormat,
    previousResponseId: previousResponseId || null,
    ...(hasTools ? { tools, toolChoice: "auto" } : {}),
    timeoutMs,
    temperature: config.temperature,
    maxOutputTokens: config.maxOutputTokens,
    metadata: buildStringMetadata({
      version: config.version,
      stageIndex,
      bundleId: bundleSummary?.bundleId || null,
      username: bundleSummary?.username || "",
    }),
  };

  executorLog("running executor request", {
    model: config.model,
    stageIndex,
    timeoutMs,
    path: hasBundleCandidates ? "v3_bundle_authoring" : hasStrategies ? "v3_evidence_strategy" : hasTemplates ? "v2_template_fill" : "v1_legacy",
    templateCandidateCount: hasTemplates ? templateCandidates.length : 0,
    bundleCandidateCount: hasBundleCandidates ? bundleCandidates.length : 0,
    strategyCount: hasStrategies ? viableStrategies.length : 0,
    hasPreviousResponseId: Boolean(previousResponseId),
    previousResponseId: previousResponseId || null,
    bundleId: bundleSummary?.bundleId || null,
  });

  const runWithBaseRequest = async (requestBase = baseRequest) => {
    const runResponseRequest = async (requestPatch = {}) => {
      return createResponseFn({
        ...requestBase,
        ...requestPatch,
      });
    };
    return runToolLoopFn({
      runResponseRequest,
      baseRequest: requestBase,
      toolContext: toolContext || {},
      toolPolicy: config.toolPolicy || null,
      maxTurns: Math.max(1, Number(config.maxToolTurns || 2)),
    });
  };

  let response = await runWithBaseRequest(baseRequest);
  let normalized = normalizeExecutorResponse(response);
  const shouldRetryWithoutPreviousResponseId = !normalized.ok
    && normalized.status === "http_error"
    && /^HTTP 400\b/i.test(String(normalized.error || ""))
    && Boolean(baseRequest.previousResponseId);

  if (shouldRetryWithoutPreviousResponseId) {
    executorLog("retrying executor request without previous_response_id after HTTP 400", {
      bundleId: bundleSummary?.bundleId || null,
      stageIndex: Math.max(0, Number(stageIndex) || 0),
      previousResponseId: baseRequest.previousResponseId,
    });
    const retryBaseRequest = {
      ...baseRequest,
      previousResponseId: null,
    };
    response = await runWithBaseRequest(retryBaseRequest);
    normalized = normalizeExecutorResponse(response);
  }

  if (!normalized.ok) {
    const failReason = normalized.status === "invalid_output"
      ? "invalid_output"
      : /timeout/i.test(String(normalized.error || ""))
        ? "timeout"
        : /^HTTP \d+/i.test(String(normalized.error || ""))
          ? "http_error"
          : "executor_failed";
    executorLog("path=executor_failed reason=" + failReason, {
      status: normalized.status || "error",
      error: normalized.error || "",
      responseId: normalized.responseId || null,
      previousResponseId: previousResponseId || null,
      toolCallCount: Array.isArray(normalized.toolCalls) ? normalized.toolCalls.length : 0,
    });
    if (normalized.status === "invalid_output") {
      executorLog("executor output missing valid json", {
        responseId: normalized.responseId || null,
        status: normalized.status,
        outputPreview: sanitizeText(normalized.outputText, 240, ""),
      });
    }
    return normalized;
  }

  executorLog("path=executor_used responseId=" + (normalized.responseId || "null") + " stageIndex=" + (stageIndex ?? "null") + " bundleId=" + (bundleSummary?.bundleId || "null"), {
    responseId: normalized.responseId || null,
    status: normalized.status || "completed",
    previousResponseId: previousResponseId || null,
    toolEventCount: Array.isArray(normalized.toolEvents) ? normalized.toolEvents.length : 0,
  });

  return normalized;
}

module.exports = {
  buildExecutorInput,
  buildExecutorBundleInputV3,
  buildExecutorInputV2,
  buildExecutorInputV3,
  normalizeExecutorResponse,
  resolveTimeoutMs,
  runExecutorRequest,
};
