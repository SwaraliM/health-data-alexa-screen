/**
 * backend/services/qna/chartQnaAgent.js
 *
 * Lightweight LLM agent that answers a user's follow-up question about
 * the currently displayed chart. Uses the stage's chart_data plus the
 * bundle's pre-computed evidence — no new Fitbit fetch, no chart
 * generation, no stage mutation.
 */

"use strict";

const { AGENT_CONFIGS } = require("../../configs/agentConfigs");
const { createResponse } = require("../openai/responsesClient");

const DEBUG = process.env.QNA_CHART_QNA_DEBUG !== "false";

function log(message, data = null) {
  if (!DEBUG) return;
  if (data == null) return console.log(`[ChartQnaAgent] ${message}`);
  console.log(`[ChartQnaAgent] ${message}`, data);
}

function warn(message, data = null) {
  if (data == null) return console.warn(`[ChartQnaAgent] ${message}`);
  console.warn(`[ChartQnaAgent] ${message}`, data);
}

function sanitizeText(value, max = 320, fallback = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : fallback;
}

/**
 * Extract the evidence slice relevant to a stage's metrics.
 */
function extractRelevantEvidence(stage = {}, evidenceBundle = {}) {
  const stageMetrics = stage?.metadata?.stageMetrics
    || stage?.chartSpec?.focusMetrics
    || [];
  const subAnalyses = evidenceBundle?.sub_analyses || {};
  const crossAnalysis = evidenceBundle?.cross_analysis || {};

  const relevantStats = {};
  for (const [saId, sa] of Object.entries(subAnalyses)) {
    if (!sa?.stats) continue;
    for (const [metric, stats] of Object.entries(sa.stats)) {
      if (stageMetrics.length === 0 || stageMetrics.includes(metric)) {
        relevantStats[metric] = stats;
      }
    }
  }

  return {
    stats: relevantStats,
    anomalies: evidenceBundle?.anomaly_summary || null,
    correlations: crossAnalysis?.correlations || null,
    deltas: crossAnalysis?.deltas || null,
  };
}

/**
 * Extract raw data rows for the stage's sub-analysis window.
 */
function extractRelevantRawData(stage = {}, multiWindowData = {}) {
  if (!multiWindowData || typeof multiWindowData !== "object") return null;

  const stageMetrics = stage?.metadata?.stageMetrics
    || stage?.chartSpec?.focusMetrics
    || [];

  for (const [saId, sa] of Object.entries(multiWindowData)) {
    if (!sa?.normalizedTable?.length) continue;
    const saMetrics = sa.metrics || [];
    const overlap = stageMetrics.length === 0
      || stageMetrics.some((m) => saMetrics.includes(m));
    if (overlap) {
      return sa.normalizedTable.slice(0, 60);
    }
  }

  const firstSa = Object.values(multiWindowData)[0];
  return firstSa?.normalizedTable?.slice(0, 60) || null;
}

function buildAgentInput({ question, stage, evidence, rawRows }) {
  const chartSpec = stage?.chartSpec || stage?.chart_spec || {};

  return {
    question: sanitizeText(question, 360, ""),
    current_chart: {
      title: sanitizeText(stage?.title, 120, ""),
      chart_type: sanitizeText(chartSpec.chart_type, 40, ""),
      chart_title: sanitizeText(chartSpec.title, 120, ""),
      chart_subtitle: sanitizeText(chartSpec.subtitle, 160, ""),
      chart_takeaway: sanitizeText(chartSpec.takeaway, 220, ""),
      chart_data: chartSpec.chart_data || chartSpec.option || null,
    },
    narration: {
      spoken_text: sanitizeText(stage?.spokenText || stage?.spoken_text, 400, ""),
      screen_text: sanitizeText(stage?.screenText || stage?.screen_text, 400, ""),
    },
    evidence: evidence || null,
    raw_data: rawRows || null,
  };
}

/**
 * Answer a follow-up question about the current chart.
 *
 * @param {object} opts
 * @param {string} opts.question
 * @param {object} opts.stage - current stage record
 * @param {object} opts.evidenceBundle - from the bundle's stored evidence
 * @param {object} opts.multiWindowData - from the bundle's stored data
 * @returns {Promise<{ ok: boolean, voice_answer: string }>}
 */
async function answerChartQuestion({ question, stage, evidenceBundle, multiWindowData } = {}) {
  const config = AGENT_CONFIGS.chartQna;
  if (!config?.enabled) {
    return { ok: false, voice_answer: "" };
  }

  const safeQuestion = sanitizeText(question, 360, "");
  if (!safeQuestion) {
    return { ok: false, voice_answer: "" };
  }

  const evidence = extractRelevantEvidence(stage, evidenceBundle);
  const rawRows = extractRelevantRawData(stage, multiWindowData);
  const input = buildAgentInput({ question: safeQuestion, stage, evidence, rawRows });

  try {
    log("answering chart question", {
      question: safeQuestion.slice(0, 80),
      chartTitle: stage?.title,
    });

    const response = await createResponse({
      model: config.answerModel,
      input: JSON.stringify(input),
      instructions: config.answerSystemPrompt,
      responseFormat: config.answerTextFormat,
      temperature: config.temperature,
      timeoutMs: config.answerTimeoutMs,
      metadata: { agent: "chart_qna_answer", version: config.version },
    });

    if (!response?.ok) {
      warn("answer request failed", {
        status: response?.status,
        error: response?.error,
      });
      return { ok: false, voice_answer: "" };
    }

    const raw = response.outputJson || null;
    if (!raw || typeof raw !== "object" || !raw.voice_answer) {
      warn("answer returned no valid output");
      return { ok: false, voice_answer: "" };
    }

    const voiceAnswer = sanitizeText(raw.voice_answer, 400, "");
    log("chart QnA answer generated", { voiceAnswer: voiceAnswer.slice(0, 100) });

    return { ok: true, voice_answer: voiceAnswer };
  } catch (error) {
    warn("answer threw", { message: error?.message || String(error) });
    return { ok: false, voice_answer: "" };
  }
}

module.exports = { answerChartQuestion };
