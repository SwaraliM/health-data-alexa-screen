/* eslint-disable */
// @ts-nocheck
/**
 * backend/services/qnaEngine.js
 *
 * Core QnA pipeline:
 * 1. GPT-first planner, heuristic fallback
 * 2. Backend-owned evidence bundle fetches
 * 3. Deterministic summary bundle + math
 * 4. GPT-assisted presentation intent, deterministic chart rendering
 * 5. Primary answer + primary visual + follow-up context
 */

const User = require("../models/Users");
const {
  VISUAL_SYSTEM,
  metricToPalette,
  FETCH_PLANNER_CONFIG,
  PRESENT_CONFIG,
  FOLLOWUP_CONFIG,
} = require("../configs/openAiSystemConfigs");
const { callOpenAIJson } = require("./openAIClient");
const {
  calculateStats,
  comparePeriods,
  compareNPeriods,
  buildSyntheticPeriodComparison,
  pickHighlight,
  detectAnomalies,
  describeRelationship,
  alignSeriesMap,
  percentChange,
  groupWeekdayWeekend,
  strongestChangeDay,
  rankMetricRelationships,
  summarizeIntradayFacts,
  summarizeSleepQuality,
} = require("./chartInsightService");
const {
  buildEstimatedIntradaySeries,
  getIntradayAvailability,
  isIntradayMetric,
  toMetricSeries,
  toSleepSeries,
  toSleepStageBreakdown,
  toSleepStageComparison,
  toSleepStageTrendSeries,
  toSleepTimingSummary,
  toSleepStageTimeline,
  summarizeIntradayWindows,
  sliceLast,
} = require("./chartDataService");
const {
  validateChartSpec,
  buildFallbackChartSpec,
} = require("./chartSpecService");

const DEFAULT_VOICE_DEADLINE_MS = Number.isFinite(Number(process.env.QNA_VOICE_DEADLINE_MS))
  ? Number(process.env.QNA_VOICE_DEADLINE_MS)
  : 8000;

const QNA_DEBUG = process.env.QNA_DEBUG !== "false";
const QNA_TRACE_DEBUG = process.env.QNA_DEBUG_TRACES !== "false";
const SYNTHETIC_INTRADAY_NOTE = "Estimated from Fitbit daily summary and logged activities because minute-level intraday detail was unavailable.";

const PANEL_SLOT_PALETTES = [
  { primary: "#2563EB", secondary: "#60A5FA", accent: "#93C5FD", series: ["#2563EB", "#60A5FA", "#93C5FD"], background: "#EFF6FF", text: "#1E3A8A" },
  { primary: "#0D9488", secondary: "#2DD4BF", accent: "#5EEAD4", series: ["#0D9488", "#2DD4BF", "#5EEAD4"], background: "#F0FDFA", text: "#134E4A" },
  { primary: "#D97706", secondary: "#F59E0B", accent: "#FBBF24", series: ["#D97706", "#F59E0B", "#FBBF24"], background: "#FFFBEB", text: "#78350F" },
  { primary: "#7C3AED", secondary: "#A78BFA", accent: "#C4B5FD", series: ["#7C3AED", "#A78BFA", "#C4B5FD"], background: "#F5F3FF", text: "#4C1D95" },
];

function qnaLog(scope, message, data = null) {
  if (!QNA_DEBUG) return;
  if (data == null) return console.log(`[QnA][${scope}] ${message}`);
  console.log(`[QnA][${scope}] ${message}`, data);
}

function qnaWarn(scope, message, data = null) {
  if (data == null) return console.warn(`[QnA][${scope}] ${message}`);
  console.warn(`[QnA][${scope}] ${message}`, data);
}

function qnaError(scope, message, error = null) {
  if (!error) return console.error(`[QnA][${scope}] ${message}`);
  console.error(`[QnA][${scope}] ${message}`, {
    message: error?.message || String(error),
    stack: error?.stack || null,
  });
}

function qnaTrace(stage, trace) {
  console.log(`[QnA][gpt-trace][${stage}]`, trace);
}

function sanitizePlainText(value, max = 220, fallback = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : fallback;
}

function sanitizeListText(values, maxItems = 4, maxLen = 90) {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => sanitizePlainText(value, maxLen, ""))
    .filter(Boolean)
    .slice(0, maxItems);
}

function toTitleCase(text = "") {
  const source = String(text || "").trim();
  return source ? `${source.charAt(0).toUpperCase()}${source.slice(1)}` : "";
}

function summarizeForTrace(value, max = 320) {
  return sanitizePlainText(
    typeof value === "string" ? value : JSON.stringify(value ?? {}),
    max,
    ""
  );
}

function createDebugTrace() {
  return QNA_TRACE_DEBUG ? { gpt_trace: {} } : null;
}

function recordTrace(debug, stage, trace = {}, usedFallback = false) {
  const normalized = {
    status: sanitizePlainText(trace?.status, 40, usedFallback ? "fallback" : "unknown"),
    used_fallback: Boolean(usedFallback),
    request_summary: summarizeForTrace(trace?.request_summary, 320),
    response_summary: summarizeForTrace(trace?.response_summary, 320),
    error_message: sanitizePlainText(trace?.error_message, 220, ""),
  };
  qnaTrace(stage, normalized);
  if (!debug?.gpt_trace) return;
  debug.gpt_trace[stage] = normalized;
}

function attachDebugPayload(payload, debug) {
  if (!payload || !debug?.gpt_trace || !Object.keys(debug.gpt_trace).length) return payload;
  return {
    ...payload,
    debug: {
      ...(payload.debug || {}),
      gpt_trace: { ...debug.gpt_trace },
    },
  };
}

function didTraceUseFallback(debug, stage) {
  return Boolean(debug?.gpt_trace?.[stage]?.used_fallback);
}

function setPayloadVoiceState(payload, voiceAnswer = "", voiceAnswerSource = "fallback", answerReady = voiceAnswerSource === "gpt", debug = null) {
  const normalizedSource = voiceAnswerSource === "gpt"
    ? "gpt"
    : voiceAnswerSource === "bridge"
      ? "bridge"
      : "fallback";
  const nextVoice = sanitizePlainText(
    voiceAnswer,
    VISUAL_SYSTEM.voice.maxChars,
    payload?.spoken_answer || payload?.voice_answer || ""
  );

  return attachDebugPayload({
    ...payload,
    spoken_answer: nextVoice,
    voice_answer: nextVoice,
    voice_answer_source: normalizedSource,
    answer_ready: Boolean(answerReady),
    payload_ready: true,
    summary: {
      ...(payload?.summary || {}),
      shortSpeech: nextVoice,
      shortText: payload?.summary?.shortText || payload?.takeaway || nextVoice,
    },
  }, debug);
}

function verbalizeSpeechNumbers(text = "") {
  return String(text || "").replace(/(\d+)\.(\d+)/g, (_, whole, fraction) => `${whole} point ${fraction.split("").join(" ")}`);
}

function compressAlexaSpeech(text = "", fallback = "Here is your health summary.") {
  const source = sanitizePlainText(text, VISUAL_SYSTEM.voice.maxChars, fallback);
  const protectedSource = source.replace(/(\d+)\.(\d+)/g, (_, whole, fraction) => `${whole}__DECIMAL__${fraction}`);
  const sentences = protectedSource
    .split(/[.!?]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, VISUAL_SYSTEM.voice.maxSentences);
  const combined = (sentences.length ? `${sentences.join(". ")}.` : protectedSource).replace(/__DECIMAL__/g, ".");
  const words = combined.split(/\s+/).filter(Boolean).slice(0, VISUAL_SYSTEM.voice.maxWords);
  const limited = verbalizeSpeechNumbers(words.join(" "));
  return limited.length <= VISUAL_SYSTEM.voice.maxChars
    ? limited
    : `${limited.slice(0, VISUAL_SYSTEM.voice.maxChars - 3).trimEnd()}...`;
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function computeDateWindow(timeScope = "last_7_days", multiplier = 1) {
  const config = VISUAL_SYSTEM.timeScopeConfig?.[timeScope] || VISUAL_SYSTEM.timeScopeConfig.last_7_days;
  const now = new Date();
  const end = new Date(now);
  end.setDate(now.getDate() - Number(config.offsetDays || 0));
  const windowDays = Math.max(1, Number(config.baseDays || 7) * Math.max(1, Number(multiplier || 1)));
  const start = new Date(end);
  start.setDate(end.getDate() - (windowDays - 1));
  return {
    baseDays: Number(config.baseDays || 7),
    windowDays,
    startDate: formatDate(start),
    endDate: formatDate(end),
    timeframeLabel: config.label || "last 7 days",
  };
}

async function getUserContext(username) {
  qnaLog("planner", "loading user context", { username: String(username || "").slice(0, 30) });
  try {
    const user = await User.findOne({ username: String(username || "").toLowerCase() });
    if (!user) return null;
    return {
      age: user?.userProfile?.age || null,
      healthGoals: Array.isArray(user?.userProfile?.healthGoals) ? user.userProfile.healthGoals : [],
      preferences: {
        dailyStepGoal: Number(user?.userProfile?.preferences?.dailyStepGoal) || 10000,
        sleepGoalMinutes: Number(user?.userProfile?.preferences?.sleepGoalMinutes) || 480,
      },
    };
  } catch (error) {
    qnaError("planner", "failed to load user context", error);
    return null;
  }
}

function metricLabel(metricKey) {
  const map = {
    steps: "steps",
    distance: "distance",
    floors: "floors climbed",
    elevation: "elevation",
    calories: "calories",
    sleep_minutes: "sleep",
    sleep_efficiency: "sleep efficiency",
    wake_minutes: "awake time",
    breathing_rate: "breathing rate",
    spo2: "blood oxygen",
    weight: "weight",
    body_fat: "body fat",
    resting_hr: "resting heart rate",
    heart_intraday: "heart rate",
    steps_intraday: "steps",
    calories_intraday: "calories",
    distance_intraday: "distance",
    floors_intraday: "floors climbed",
    hrv: "HRV",
  };
  return map[metricKey] || "steps";
}

function metricUnit(metricKey) {
  const map = {
    steps: "steps",
    distance: "mi",
    floors: "floors",
    elevation: "ft",
    calories: "cal",
    sleep_minutes: "hours",
    sleep_efficiency: "%",
    wake_minutes: "min",
    breathing_rate: "brpm",
    spo2: "%",
    weight: "kg",
    body_fat: "%",
    resting_hr: "bpm",
    heart_intraday: "bpm",
    steps_intraday: "steps",
    calories_intraday: "cal",
    distance_intraday: "mi",
    floors_intraday: "floors",
    hrv: "ms",
  };
  return map[metricKey] || "";
}

function getGoalForMetric(metricKey, userContext) {
  if (metricKey === "steps" || metricKey === "steps_intraday") {
    return Number(userContext?.preferences?.dailyStepGoal || 10000);
  }
  if (metricKey === "sleep_minutes") {
    return Math.round((Number(userContext?.preferences?.sleepGoalMinutes || 480) / 60) * 10) / 10;
  }
  if (metricKey === "sleep_efficiency" || metricKey === "wake_minutes") {
    return 100;
  }
  return null;
}

function isSingleDayScope(timeScope = "") {
  return ["today", "yesterday", "last_night"].includes(String(timeScope || "").toLowerCase());
}

function intradayMetricForMetric(metricKey = "") {
  const metric = String(metricKey || "").toLowerCase();
  if (metric === "resting_hr") return "heart_intraday";
  if (metric === "steps") return "steps_intraday";
  if (metric === "calories") return "calories_intraday";
  if (metric === "distance") return "distance_intraday";
  if (metric === "floors") return "floors_intraday";
  if (metric.endsWith("_intraday")) return metric;
  return null;
}

function baseMetricForIntraday(metricKey = "") {
  const metric = String(metricKey || "").toLowerCase();
  if (metric === "heart_intraday") return "resting_hr";
  if (metric === "steps_intraday") return "steps";
  if (metric === "calories_intraday") return "calories";
  if (metric === "distance_intraday") return "distance";
  if (metric === "floors_intraday") return "floors";
  return metric;
}

function inferTimeScope(question = "") {
  const q = String(question).toLowerCase();
  if (/\blast\s*night\b/.test(q)) return "last_night";
  if (/\byesterday\b/.test(q)) return "yesterday";
  if (/\btoday\b/.test(q)) return "today";
  if (/\bthis\s*week\b/.test(q)) return "this_week";
  if (/\blast\s*week\b/.test(q)) return "last_week";
  if (/\b(month|30\s*days|4\s*weeks)\b/.test(q)) return "last_30_days";
  return "last_7_days";
}

function detectIntradayIntent(question = "") {
  return /\b(by hour|hourly|during the day|through the day|this morning|this afternoon|this evening|today over time|spike|dip|timeline|intraday)\b/i.test(question);
}

function detectOverviewIntent(question = "") {
  return /\b(overall|overview|report|summary|how am i doing|how have i been doing|what should i know|what stands out|check in|big picture|lately)\b/i.test(question);
}

function isActivityMetric(metricKey = "") {
  return ["steps", "calories", "distance", "floors", "elevation"].includes(baseMetricForIntraday(metricKey));
}

function enrichActivityOnlyMetrics(metricsNeeded = [], timeScope = "last_7_days") {
  const current = (Array.isArray(metricsNeeded) ? metricsNeeded : []).filter(Boolean);
  if (!current.length || !current.every((metricKey) => isActivityMetric(metricKey))) {
    return current.slice(0, 4);
  }

  const focusMetric = current[0];
  const focusBaseMetric = baseMetricForIntraday(focusMetric);
  const ordered = [];
  const push = (metricKey) => {
    if (metricKey && !ordered.includes(metricKey)) ordered.push(metricKey);
  };

  if (isSingleDayScope(timeScope)) {
    push(intradayMetricForMetric(focusBaseMetric) || focusMetric);
  } else {
    push(focusBaseMetric);
  }
  push(focusBaseMetric);
  ["steps", "calories", "floors", "distance"].forEach(push);

  return ordered.slice(0, 4);
}

function extractMentionedMetrics(question = "") {
  const q = String(question).toLowerCase();
  const metrics = [];
  const isOverview = detectOverviewIntent(q);
  const push = (metric) => {
    if (metric && !metrics.includes(metric)) metrics.push(metric);
  };

  if (/sleep|slept|bed|nap/.test(q)) push("sleep_minutes");
  if (/efficiency/.test(q)) push("sleep_efficiency");
  if (/awake|wake/.test(q)) push("wake_minutes");
  if (/breathing|respiratory|breath rate|breaths per minute/.test(q)) push("breathing_rate");
  if (/spo2|blood oxygen|oxygen saturation|oxygen level/.test(q)) push("spo2");
  if (/\bweight|weigh|bmi\b/.test(q)) push("weight");
  if (/body fat|fat percentage|body composition/.test(q)) push("body_fat");
  if (/resting|heart|pulse|bpm/.test(q)) push("resting_hr");
  if (/hrv|variability|recovery|stress/.test(q)) push("hrv");
  if (/calorie|burn|workout|exercise/.test(q)) push("calories");
  if (/distance|mile|miles/.test(q)) push("distance");
  if (/floor|floors|stairs/.test(q)) push("floors");
  if (/elevation/.test(q)) push("elevation");
  if (/step|steps|walk|walking|activity|active|movement/.test(q)) push("steps");

  if (isOverview) {
    push("sleep_minutes");
    push("breathing_rate");
    push("spo2");
    push("steps");
    push("resting_hr");
  }

  if (!metrics.length) {
    const energyProxy = VISUAL_SYSTEM.proxyMap.energy || "steps";
    if (Array.isArray(energyProxy)) energyProxy.forEach(push);
    else push(energyProxy);
  }

  if (detectIntradayIntent(q)) {
    if (metrics.includes("resting_hr")) metrics[metrics.indexOf("resting_hr")] = "heart_intraday";
    if (metrics.includes("steps")) metrics[metrics.indexOf("steps")] = "steps_intraday";
    if (metrics.includes("calories")) metrics[metrics.indexOf("calories")] = "calories_intraday";
    if (metrics.includes("distance")) metrics[metrics.indexOf("distance")] = "distance_intraday";
    if (metrics.includes("floors")) metrics[metrics.indexOf("floors")] = "floors_intraday";
  }

  if ((/compare|with|versus|vs/i.test(q)) && metrics.length === 1) {
    if (metrics[0] === "sleep_minutes") push("steps");
    else push("sleep_minutes");
  }

  if ((/relationship|correlat|related|affect|impact/i.test(q)) && metrics.length === 1) {
    if (metrics[0] === "sleep_minutes") push("steps");
    else if (metrics[0] === "steps") push("sleep_minutes");
    else push("steps");
  }

  return metrics.slice(0, 4);
}

/**
 * Heuristic planner remains available as a strict fallback path.
 */
function inferHeuristicFetchPlan(question = "") {
  const q = String(question).toLowerCase();
  const isOverview = detectOverviewIntent(q);
  const requestedMetrics = extractMentionedMetrics(q);
  const requestedMetricCount = requestedMetrics.length;
  let question_type = isOverview ? "overview_report" : "single_metric_status";
  if (/\bcompare|versus|vs|better|worse|previous|changed|than before\b/.test(q)) question_type = "comparison_report";
  if (/\bpattern|trend|over time|usually|consisten|stand out|anomaly|unusual|spike|dip\b/.test(q)) question_type = "anomaly_explanation";
  if (/\bexplain|what am i looking at|what am i seeing|chart|graph\b/.test(q)) question_type = "chart_explanation";
  if (/\baffect|relationship|related|correlat|compare this with|impact\b/.test(q)) question_type = "relationship_report";
  if (/\bgoal|target|progress|close to|met\b/.test(q)) question_type = "goal_progress";
  if (/\bshow more|continue|go deeper|more detail|drill down\b/.test(q)) question_type = "deep_dive";
  if (/\breminder|medicine|medication|pill\b/.test(q)) question_type = "reminder";
  if (isOverview && /\bdetail|deeper|deep dive\b/.test(q)) question_type = "deep_dive";

  const time_scope = inferTimeScope(q);
  const enrichedMetrics = enrichActivityOnlyMetrics(requestedMetrics, time_scope);
  const singleDayScope = isSingleDayScope(time_scope);
  const shouldBiasIntraday = singleDayScope && enrichedMetrics.some((metric) => intradayMetricForMetric(metric));
  const comparison_mode = question_type === "comparison_report"
    ? "previous_period"
    : question_type === "relationship_report" || requestedMetricCount > 1
      ? "metric_vs_metric"
      : "none";
  const evidence_scope = [];
  if (enrichedMetrics.some((metric) => ["sleep_minutes", "sleep_efficiency", "wake_minutes", "breathing_rate", "spo2"].includes(metric))) {
    evidence_scope.push("sleep_core");
    evidence_scope.push("sleep_timing_and_stages");
  }
  if (/\bquality|restful|restless|stages|rem|deep|light|bedtime|wake up|wake-up\b/.test(q)) evidence_scope.push("sleep_timing_and_stages");
  if (enrichedMetrics.some((metric) => String(metric).endsWith("_intraday"))) evidence_scope.push("daily_activity_breakdown");
  if (shouldBiasIntraday) evidence_scope.push("daily_activity_breakdown");
  if (enrichedMetrics.some((metric) => metric === "resting_hr" || metric === "hrv" || metric === "heart_intraday")) evidence_scope.push("heart_recovery");
  if (question_type === "relationship_report") evidence_scope.push("relationship_bundle");
  if (/\bunusual|anomaly|off|consisten|variability|stand out|spike|dip\b/.test(q)) evidence_scope.push("weekly_anomaly_scan");
  if (/\bchart|screen|seeing|showing|explain\b/.test(q)) evidence_scope.push("screen_context_expansion");
  if (isOverview) evidence_scope.push("sleep_core", "activity_core", "heart_recovery", "weekly_anomaly_scan");
  if (!evidence_scope.length && !enrichedMetrics.some((metric) => ["weight", "body_fat", "breathing_rate", "spo2"].includes(metric))) {
    evidence_scope.push("activity_core");
  }

  let preferred_chart = isOverview ? "composed_summary" : "bar";
  if (requestedMetricCount > 1) preferred_chart = isOverview ? "composed_summary" : "multi_line";
  if (question_type === "goal_progress") preferred_chart = "gauge";
  if (question_type === "comparison_report") preferred_chart = "grouped_bar";
  if (question_type === "anomaly_explanation") preferred_chart = isOverview ? "composed_summary" : "area";
  if (question_type === "relationship_report") preferred_chart = "scatter";
  if (question_type === "chart_explanation" && detectIntradayIntent(q)) preferred_chart = "timeline";
  if (question_type === "chart_explanation" && isOverview) preferred_chart = "composed_summary";

  const response_mode = (question_type === "overview_report"
    || question_type === "relationship_report"
    || question_type === "deep_dive"
    || (question_type === "comparison_report" && requestedMetricCount > 1))
    ? "multi_panel_report"
    : "single_view";
  if (shouldBiasIntraday && response_mode !== "multi_panel_report") preferred_chart = detectIntradayIntent(q) ? "timeline" : "area";
  const visual_goals = response_mode === "multi_panel_report"
    ? [question_type, "comparison_report", requestedMetricCount > 1 ? "relationship_report" : "single_metric_status"].slice(0, 4)
    : [question_type];
  const layout_hint = response_mode === "single_view"
    ? "single_focus"
    : visual_goals.length >= 4
      ? "four_panel_grid"
      : visual_goals.length === 3
        ? "two_up_plus_footer"
        : "two_up";

  return {
    question_type,
    response_mode,
    metrics_needed: enrichedMetrics.slice(0, 4),
    time_scope,
    comparison_mode,
    needs_previous_period: comparison_mode === "previous_period",
    needs_intraday: detectIntradayIntent(q) || shouldBiasIntraday,
    evidence_scope: [...new Set(evidence_scope)].slice(0, 4),
    needs_relationship_scan: question_type === "relationship_report",
    needs_goal_context: question_type === "goal_progress" || /\bgoal|target|progress\b/.test(q),
    needs_screen_context: question_type === "chart_explanation" || /\bchart|screen|seeing\b/.test(q),
    followup_mode: question_type === "chart_explanation" ? "chart_aware" : "suggested_drill_down",
    preferred_chart,
    visual_goals,
    layout_hint,
    drill_down_candidates: defaultSuggestedQuestions(enrichedMetrics[0], question_type),
  };
}

function normalizeMetric(rawMetric) {
  const metric = String(rawMetric || "").trim().toLowerCase();
  if (VISUAL_SYSTEM.allowed.metrics.includes(metric)) return metric;
  return VISUAL_SYSTEM.metricAliases?.[metric] || null;
}

function getStaticDefaultPlan() {
  return {
    question_type: "overview_report",
    response_mode: "single_view",
    metrics_needed: ["steps"],
    time_scope: VISUAL_SYSTEM.app.defaultTimeScope || "last_7_days",
    comparison_mode: "none",
    needs_previous_period: false,
    needs_intraday: false,
    evidence_scope: ["activity_core"],
    needs_relationship_scan: false,
    needs_goal_context: false,
    needs_screen_context: false,
    followup_mode: "suggested_drill_down",
    preferred_chart: "bar",
    visual_goals: ["overview_report"],
    layout_hint: "single_focus",
    drill_down_candidates: defaultSuggestedQuestions("steps", "overview_report"),
  };
}

function normalizeFetchPlan(rawPlan, fallbackPlan) {
  const plan = rawPlan && typeof rawPlan === "object" ? rawPlan : {};
  const fallback = fallbackPlan ?? getStaticDefaultPlan();
  const requestedMetrics = Array.isArray(plan.metrics_needed)
    ? plan.metrics_needed.map(normalizeMetric).filter(Boolean).slice(0, 4)
    : [];
  const time_scope = VISUAL_SYSTEM.app.supportedTimeScopes.includes(plan.time_scope)
    ? plan.time_scope
    : fallback.time_scope;
  const metrics_needed = enrichActivityOnlyMetrics(
    requestedMetrics.length ? requestedMetrics : fallback.metrics_needed,
    time_scope,
  );

  return {
    question_type: VISUAL_SYSTEM.allowed.questionTypes.includes(plan.question_type)
      ? plan.question_type
      : fallback.question_type,
    response_mode: VISUAL_SYSTEM.allowed.responseModes.includes(plan.response_mode)
      ? plan.response_mode
      : fallback.response_mode,
    metrics_needed: metrics_needed.length ? metrics_needed : fallback.metrics_needed,
    time_scope,
    comparison_mode: VISUAL_SYSTEM.allowed.comparisonModes.includes(plan.comparison_mode)
      ? plan.comparison_mode
      : fallback.comparison_mode,
    needs_previous_period: plan.needs_previous_period == null
      ? fallback.needs_previous_period
      : Boolean(plan.needs_previous_period),
    needs_intraday: plan.needs_intraday == null
      ? fallback.needs_intraday
      : Boolean(plan.needs_intraday),
    evidence_scope: Array.isArray(plan.evidence_scope)
      ? plan.evidence_scope.filter((item) => VISUAL_SYSTEM.allowed.evidenceScopes.includes(item)).slice(0, 4)
      : fallback.evidence_scope,
    needs_relationship_scan: Boolean(plan.needs_relationship_scan),
    needs_goal_context: plan.needs_goal_context == null ? fallback.needs_goal_context : Boolean(plan.needs_goal_context),
    needs_screen_context: plan.needs_screen_context == null ? fallback.needs_screen_context : Boolean(plan.needs_screen_context),
    followup_mode: VISUAL_SYSTEM.allowed.followupModes.includes(plan.followup_mode)
      ? plan.followup_mode
      : fallback.followup_mode,
    preferred_chart: VISUAL_SYSTEM.allowed.chartTypes.includes(plan.preferred_chart)
      ? plan.preferred_chart
      : fallback.preferred_chart,
    visual_goals: Array.isArray(plan.visual_goals)
      ? plan.visual_goals.filter((item) => VISUAL_SYSTEM.allowed.reportGoals.includes(item)).slice(0, 4)
      : fallback.visual_goals,
    layout_hint: VISUAL_SYSTEM.allowed.layouts.includes(plan.layout_hint)
      ? plan.layout_hint
      : fallback.layout_hint,
    drill_down_candidates: sanitizeListText(plan.drill_down_candidates, 4, 80).length
      ? sanitizeListText(plan.drill_down_candidates, 4, 80)
      : fallback.drill_down_candidates,
    num_comparison_periods: Math.min(4, Math.max(2, Number(plan.num_comparison_periods) || 2)),
  };
}

async function maybeRefineFetchPlan(question, heuristicPlan, timeoutMs = FETCH_PLANNER_CONFIG.timeoutMs, debug = null) {
  qnaLog("planner", "requesting GPT planner", { question, timeoutMs });
  const parsed = await callOpenAIJson({
    systemPrompt: FETCH_PLANNER_CONFIG.systemPrompt,
    userPayload: {
      question,
      allowedQuestionTypes: VISUAL_SYSTEM.allowed.questionTypes,
      allowedMetrics: VISUAL_SYSTEM.allowed.metrics,
      allowedTimeScopes: VISUAL_SYSTEM.app.supportedTimeScopes,
      allowedComparisonModes: VISUAL_SYSTEM.allowed.comparisonModes,
      allowedEvidenceScopes: VISUAL_SYSTEM.allowed.evidenceScopes,
      allowedFollowupModes: VISUAL_SYSTEM.allowed.followupModes,
      allowedResponseModes: VISUAL_SYSTEM.allowed.responseModes,
      allowedLayouts: VISUAL_SYSTEM.allowed.layouts,
      allowedReportGoals: VISUAL_SYSTEM.allowed.reportGoals,
      allowedChartTypes: VISUAL_SYSTEM.allowed.chartTypes,
    },
    model: FETCH_PLANNER_CONFIG.model,
    maxTokens: FETCH_PLANNER_CONFIG.maxTokens,
    temperature: FETCH_PLANNER_CONFIG.temperature,
    timeoutMs,
    jsonSchema: FETCH_PLANNER_CONFIG.jsonSchema,
    onTrace: (trace) => recordTrace(debug, "planner", trace, false),
  });

  if (!parsed) {
    qnaWarn("planner", "GPT planner failed, using heuristic fallback");
    if (debug?.gpt_trace?.planner) debug.gpt_trace.planner.used_fallback = true;
    else recordTrace(debug, "planner", {
      status: "fallback",
      request_summary: summarizeForTrace({ question }),
      response_summary: "Heuristic fetch plan used",
      error_message: "Planner unavailable",
    }, true);
    return heuristicPlan != null ? heuristicPlan : inferHeuristicFetchPlan(question);
  }

  const normalized = normalizeFetchPlan(parsed, heuristicPlan);
  qnaLog("planner", "GPT planner succeeded", normalized);
  return normalized;
}

async function fetchJsonWithTimeout(url, timeoutMs = null) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timeoutEnabled = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0;
  const timeoutId = timeoutEnabled && controller
    ? setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs)))
    : null;
  try {
    const response = await fetch(url, { signal: controller?.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const err = new Error(`Fetch failed (${response.status}): ${body.slice(0, 180)}`);
      qnaError("fetch", "fetchJsonWithTimeout HTTP error", err);
      throw err;
    }
    return await response.json();
  } catch (err) {
    if (err.name === "AbortError") qnaWarn("fetch", "fetchJsonWithTimeout timeout", { url: url?.slice?.(0, 80) });
    else if (!err.message?.includes("Fetch failed")) qnaError("fetch", "fetchJsonWithTimeout", err);
    throw err;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function normalizeInternalApiBase(candidate = "") {
  const value = String(candidate || "").trim();
  if (!value) return "";
  return value.replace(/\/+$/, "").replace(/\/api$/, "");
}

function resolveInternalApiBaseUrl() {
  // Prefer REACT_APP_FETCH_DATA_URL when set so QnA internal fetches (Fitbit summaries, etc.) use that base.
  const configuredBase = [
    process.env.REACT_APP_FETCH_DATA_URL,
    process.env.QNA_INTERNAL_API_URL,
    process.env.INTERNAL_API_URL,
    process.env.BACKEND_URL,
    process.env.API_URL,
    process.env.RENDER_EXTERNAL_URL,
    process.env.PUBLIC_BASE_URL,
  ]
    .map((value) => normalizeInternalApiBase(value))
    .find(Boolean);

  if (configuredBase) return configuredBase;

  const port = Number.parseInt(process.env.PORT, 10);
  const safePort = Number.isFinite(port) && port > 0 ? port : 5001;
  return `http://127.0.0.1:${safePort}`;
}

function buildFitbitInternalUrl({ username, metricKey, startDate, endDate, timeScope = "last_7_days" }) {
  const base = resolveInternalApiBaseUrl();
  const user = String(username || "").toLowerCase();
  if (["sleep_minutes", "sleep_efficiency", "wake_minutes"].includes(metricKey)) {
    if (isSingleDayScope(timeScope)) {
      return `${base}/api/fitbit/${user}/sleep/single-day/date/${endDate}`;
    }
    return `${base}/api/fitbit/${user}/sleep/range/date/${startDate}/${endDate}`;
  }
  if (metricKey === "breathing_rate") {
    if (isSingleDayScope(timeScope)) return `${base}/api/fitbit/${user}/br/single-day/date/${endDate}`;
    return `${base}/api/fitbit/${user}/br/range/date/${startDate}/${endDate}`;
  }
  if (metricKey === "spo2") {
    if (isSingleDayScope(timeScope)) return `${base}/api/fitbit/${user}/spo2/single-day/date/${endDate}`;
    return `${base}/api/fitbit/${user}/spo2/range/date/${startDate}/${endDate}`;
  }
  if (metricKey === "weight") {
    if (isSingleDayScope(timeScope)) return `${base}/api/fitbit/${user}/body/log/weight/date/${endDate}`;
    return `${base}/api/fitbit/${user}/body/log/weight/date/${startDate}/${endDate}`;
  }
  if (metricKey === "body_fat") {
    if (isSingleDayScope(timeScope)) return `${base}/api/fitbit/${user}/body/log/fat/date/${endDate}`;
    return `${base}/api/fitbit/${user}/body/log/fat/date/${startDate}/${endDate}`;
  }
  if (metricKey === "resting_hr") return `${base}/api/fitbit/${user}/heart/range/date/${startDate}/${endDate}`;
  if (metricKey === "heart_intraday") return `${base}/api/fitbit/${user}/heart/intraday/${startDate}`;
  if (metricKey === "steps_intraday") return `${base}/api/fitbit/${user}/activities/intraday/steps/${startDate}`;
  if (metricKey === "calories_intraday") return `${base}/api/fitbit/${user}/activities/intraday/calories/${startDate}`;
  if (metricKey === "distance_intraday") return `${base}/api/fitbit/${user}/activities/intraday/distance/${startDate}`;
  if (metricKey === "floors_intraday") return `${base}/api/fitbit/${user}/activities/intraday/floors/${startDate}`;
  if (metricKey === "calories") return `${base}/api/fitbit/${user}/activities/range/calories/date/${startDate}/${endDate}`;
  if (metricKey === "distance") return `${base}/api/fitbit/${user}/activities/range/distance/date/${startDate}/${endDate}`;
  if (metricKey === "floors") return `${base}/api/fitbit/${user}/activities/range/floors/date/${startDate}/${endDate}`;
  if (metricKey === "elevation") return `${base}/api/fitbit/${user}/activities/range/elevation/date/${startDate}/${endDate}`;
  if (metricKey === "hrv") return `${base}/api/fitbit/${user}/hrv/range/date/${startDate}/${endDate}`;
  return `${base}/api/fitbit/${user}/activities/range/steps/date/${startDate}/${endDate}`;
}

function buildActivitySummaryUrl({ username, date }) {
  const base = resolveInternalApiBaseUrl();
  const user = String(username || "").toLowerCase();
  return `${base}/api/fitbit/${user}/activities/summary/${date}`;
}

function needsDailyActivitySummary(plan = {}) {
  if (!isSingleDayScope(plan.time_scope)) return false;
  const metrics = Array.isArray(plan.metrics_needed) ? plan.metrics_needed : [];
  return metrics.some((metricKey) => ["steps", "calories", "distance", "floors", "elevation", "resting_hr"].includes(baseMetricForIntraday(metricKey)));
}

function toMetricPoints(metricKey, rawPayload, windowDays) {
  if (metricKey === "sleep_minutes") return toSleepSeries(rawPayload, windowDays).sleep;
  if (metricKey === "sleep_efficiency") return toSleepSeries(rawPayload, windowDays).efficiency;
  if (metricKey === "wake_minutes") return toSleepSeries(rawPayload, windowDays).wakeMinutes;
  return toMetricSeries(metricKey, rawPayload, windowDays);
}

function hydrateIntradayMetricData({
  metricKey,
  rawPayload,
  activitySummaryRaw = null,
  targetDate = null,
  fallbackStatus = null,
  fallbackReason = "",
}) {
  let points = toMetricPoints(metricKey, rawPayload, 1);
  let availability = getIntradayAvailability(metricKey, rawPayload);
  if (fallbackStatus) {
    availability = {
      ...availability,
      status: fallbackStatus,
      reason: fallbackReason || availability.reason,
    };
  }

  let isSynthetic = false;
  if ((!points.length || availability.status !== "available") && activitySummaryRaw) {
    const syntheticPoints = buildEstimatedIntradaySeries({
      metricKey,
      activitySummaryPayload: activitySummaryRaw,
      date: targetDate,
    });
    if (syntheticPoints.length) {
      points = syntheticPoints;
      isSynthetic = true;
    }
  }

  return {
    points,
    intraday_status: availability.status,
    intraday_reason: availability.reason,
    is_synthetic: isSynthetic,
    data_quality_note: isSynthetic ? SYNTHETIC_INTRADAY_NOTE : "",
    source: isSynthetic
      ? "fitbit_summary_estimate"
      : availability.status === "summary_only"
        ? "fitbit_summary_only"
        : "fitbit_intraday",
  };
}

function defaultSuggestedQuestions(primaryMetric, questionType = "single_metric_status") {
  const subject = metricLabel(primaryMetric || "steps");
  if (questionType === "relationship_report") {
    return [
      "Show the relationship.",
      `Compare only my ${subject}.`,
      "Why do you say that?",
    ];
  }
  if (questionType === "overview_report" || questionType === "deep_dive") {
    return [
      "Show more.",
      `Show ${subject} detail.`,
      "What stands out lately?",
    ];
  }
  return [
    "Explain this graph.",
    `Compare only my ${subject}.`,
    "Show more.",
  ];
}

function expandEvidenceMetrics(plan) {
  const metrics = new Set(Array.isArray(plan.metrics_needed) ? plan.metrics_needed : ["steps"]);
  const scopes = Array.isArray(plan.evidence_scope) ? plan.evidence_scope : [];
  if (isSingleDayScope(plan.time_scope)) {
    [...metrics].forEach((metricKey) => {
      const intradayMetric = intradayMetricForMetric(metricKey);
      if (intradayMetric) metrics.add(intradayMetric);
    });
  }
  if (scopes.includes("sleep_timing_and_stages") || scopes.includes("sleep_core")) {
    metrics.add("sleep_minutes");
    metrics.add("sleep_efficiency");
    metrics.add("wake_minutes");
    metrics.add("breathing_rate");
    metrics.add("spo2");
  }
  if (scopes.includes("activity_core")) metrics.add("steps");
  if (scopes.includes("daily_activity_breakdown") && ![...metrics].some((metric) => metric.endsWith("_intraday"))) {
    metrics.add("steps_intraday");
  }
  if (scopes.includes("heart_recovery")) {
    metrics.add("resting_hr");
    metrics.add("hrv");
  }
  if (scopes.includes("relationship_bundle") && metrics.size === 1) {
    metrics.add(metrics.has("sleep_minutes") ? "steps" : "sleep_minutes");
  }
  return [...metrics].slice(0, 4);
}

/**
 * Evidence bundle fetcher keeps endpoint mapping in backend code.
 */
async function fetchRequestedData({ username, plan, fetchTimeoutMs = null }) {
  const metrics_needed = expandEvidenceMetrics(plan);
  const comparisonNeeded = Boolean(plan.needs_previous_period)
    || plan.comparison_mode === "previous_period"
    || (plan.evidence_scope || []).includes("weekly_anomaly_scan");
  const numComparisonPeriods = Math.min(4, Math.max(2, Number(plan.num_comparison_periods) || 2));
  const window = computeDateWindow(plan.time_scope, comparisonNeeded ? numComparisonPeriods : 1);

  qnaLog("fetch", "starting evidence bundle fetch", {
      username,
    metrics_needed,
    evidence_scope: plan.evidence_scope,
    time_scope: plan.time_scope,
    comparison_mode: plan.comparison_mode,
  });

  const metricsData = {};
  const contextData = {};
  if (needsDailyActivitySummary(plan)) {
    const activitySummaryUrl = buildActivitySummaryUrl({ username, date: window.endDate });
    qnaLog("fetch", "fetching daily activity summary", { activitySummaryUrl, date: window.endDate });
    try {
      contextData.activitySummaryRaw = await fetchJsonWithTimeout(activitySummaryUrl, fetchTimeoutMs);
    } catch (error) {
      qnaWarn("fetch", "daily activity summary unavailable", { message: error?.message || String(error) });
      contextData.activitySummaryRaw = null;
    }
  }

  for (const metricKey of metrics_needed) {
    const url = buildFitbitInternalUrl({
        username,
      metricKey,
      startDate: window.startDate,
      endDate: window.endDate,
      timeScope: plan.time_scope,
    });
    qnaLog("fetch", "fetching metric", { metricKey, url, startDate: window.startDate, endDate: window.endDate });
    try {
      const raw = await fetchJsonWithTimeout(url, fetchTimeoutMs);
      const intradayMeta = isIntradayMetric(metricKey)
        ? hydrateIntradayMetricData({
            metricKey,
            rawPayload: raw,
            activitySummaryRaw: contextData.activitySummaryRaw || null,
            targetDate: window.endDate,
          })
        : null;
      const allPoints = intradayMeta?.points || toMetricPoints(metricKey, raw, window.windowDays);
      const currentPoints = isIntradayMetric(metricKey)
        ? allPoints
        : sliceLast(allPoints, window.baseDays);
      metricsData[metricKey] = {
        raw,
        all: allPoints,
        current: currentPoints,
        previous: isIntradayMetric(metricKey)
          ? []
          : (comparisonNeeded ? allPoints.slice(0, Math.max(0, allPoints.length - window.baseDays)) : []),
        intraday_status: intradayMeta?.intraday_status || null,
        intraday_reason: intradayMeta?.intraday_reason || "",
        is_synthetic: Boolean(intradayMeta?.is_synthetic),
        data_quality_note: intradayMeta?.data_quality_note || "",
        source: intradayMeta?.source || null,
      };
    } catch (err) {
      qnaWarn("fetch", "metric fetch failed, continuing with others", { metricKey, message: err?.message || String(err) });
      const intradayMeta = isIntradayMetric(metricKey)
        ? hydrateIntradayMetricData({
            metricKey,
            rawPayload: null,
            activitySummaryRaw: contextData.activitySummaryRaw || null,
            targetDate: window.endDate,
            fallbackStatus: "fetch_error",
            fallbackReason: err?.message || "Fitbit intraday fetch failed.",
          })
        : null;
      metricsData[metricKey] = {
        raw: null,
        all: intradayMeta?.points || [],
        current: intradayMeta?.points || [],
        previous: [],
        intraday_status: intradayMeta?.intraday_status || null,
        intraday_reason: intradayMeta?.intraday_reason || "",
        is_synthetic: Boolean(intradayMeta?.is_synthetic),
        data_quality_note: intradayMeta?.data_quality_note || "",
        source: intradayMeta?.source || null,
      };
    }
  }

  const requestedOrder = plan.metrics_needed && plan.metrics_needed.length ? plan.metrics_needed : metrics_needed;
  const withData = requestedOrder.filter((k) => metricsData[k]?.raw != null || (Array.isArray(metricsData[k]?.all) && metricsData[k].all.length > 0));
  const primaryMetric = withData[0] || requestedOrder[0] || metrics_needed[0] || "steps";
  const secondaryMetric = withData[1] || requestedOrder[1] || null;
  return {
    metrics_needed,
    metricsData,
    primaryMetric,
    secondaryMetric,
    primaryWindow: window,
    primaryRaw: metricsData[primaryMetric]?.raw || null,
    primaryAll: metricsData[primaryMetric]?.all || [],
    primaryCurrent: metricsData[primaryMetric]?.current || [],
    primaryPrevious: metricsData[primaryMetric]?.previous || [],
    secondaryRaw: secondaryMetric ? metricsData[secondaryMetric]?.raw || null : null,
    secondaryCurrent: secondaryMetric ? metricsData[secondaryMetric]?.current || [] : [],
    contextData,
  };
}

function buildStoryCandidates({
  primaryMetric,
  primaryStats,
  comparisonStats,
  anomalies,
  relationship,
  sleepQuality,
  intradayInsights,
  reportFacts,
  activitySummary,
}) {
  const stories = [];
  if (sleepQuality?.takeaway && ["sleep_minutes", "sleep_efficiency", "wake_minutes"].includes(primaryMetric)) {
    stories.push(sleepQuality.takeaway);
  }
  if (activitySummary?.takeaway && ["steps", "calories", "distance", "floors", "elevation", "resting_hr"].includes(baseMetricForIntraday(primaryMetric))) {
    stories.push(activitySummary.takeaway);
  }
  if (intradayInsights?.takeaway && String(primaryMetric || "").endsWith("_intraday")) {
    stories.push(intradayInsights.takeaway);
  }
  if (comparisonStats && Math.abs(comparisonStats.changePct) >= 5) {
    stories.push(`${toTitleCase(metricLabel(primaryMetric))} changed ${Math.abs(comparisonStats.changePct)} percent versus the previous period.`);
  }
  if (reportFacts?.strongestMetricChange?.metricKey && primaryMetric !== reportFacts.strongestMetricChange.metricKey) {
    stories.push(`${toTitleCase(metricLabel(reportFacts.strongestMetricChange.metricKey))} changed the most recently.`);
  }
  if (anomalies.length) stories.push(`${anomalies[0].label} was the clearest outlier.`);
  if (relationship?.statement) stories.push(relationship.statement);
  if (!stories.length) stories.push(`${toTitleCase(metricLabel(primaryMetric))} stayed relatively steady.`);
  return stories.slice(0, 3);
}

function buildActivitySummaryFacts(raw = null) {
  if (!raw || typeof raw !== "object") return null;
  const summary = raw.summary || {};
  const goals = raw.goals || {};
  const activities = Array.isArray(raw.activities) ? raw.activities : [];
  const heartZones = Array.isArray(summary.heartRateZones) ? summary.heartRateZones : [];
  const activeZoneMinutesRaw = Array.isArray(summary.activeZoneMinutes)
    ? summary.activeZoneMinutes
    : Array.isArray(summary.activeZoneMinutesBreakdown)
      ? summary.activeZoneMinutesBreakdown
      : [];
  const activeZoneMinutes = activeZoneMinutesRaw
    .map((zone) => ({
      name: sanitizePlainText(
        zone?.name || zone?.zoneName || zone?.type || zone?.minuteMultiplier || "",
        30,
        ""
      ),
      minutes: Number(
        zone?.minutes
        ?? zone?.activeZoneMinutes
        ?? zone?.minutesInHeartRateZones
        ?? zone?.value
      ) || 0,
    }))
    .filter((zone) => zone.minutes > 0);
  const totalActiveZoneMinutes = activeZoneMinutes.reduce((sum, zone) => sum + zone.minutes, 0);
  const dominantZone = heartZones
    .map((zone) => ({ name: zone?.name || "", minutes: Number(zone?.minutes) || 0 }))
    .sort((a, b) => b.minutes - a.minutes)[0] || null;
  const topActivity = activities
    .map((item) => ({
      name: sanitizePlainText(item?.name, 40, ""),
      calories: Number(item?.calories) || 0,
      durationMinutes: Math.round((Number(item?.duration) || 0) / 60000),
      steps: Number(item?.steps) || 0,
      startTime: sanitizePlainText(item?.startTime, 20, ""),
    }))
    .sort((a, b) => b.calories - a.calories || b.durationMinutes - a.durationMinutes)[0] || null;
  const steps = Number(summary.steps) || 0;
  const stepGoal = Number(goals.steps) || 0;
  const stepGoalPct = stepGoal > 0 ? Math.round((steps / stepGoal) * 100) : null;
  const floors = Number(summary.floors) || 0;
  const floorsGoal = Number(goals.floors) || 0;
  const distances = Array.isArray(summary.distances) ? summary.distances : [];
  const totalDistanceEntry = distances.find((d) => d?.activity === "total" || d?.activity === "tracker");
  const distanceMiles = Number(totalDistanceEntry?.distance) || 0;
  const distanceGoal = Number(goals.distance) || 0;
  const activeMinutes = (Number(summary.veryActiveMinutes) || 0) + (Number(summary.fairlyActiveMinutes) || 0) + (Number(summary.lightlyActiveMinutes) || 0);
  const activeMinutesGoal = Number(goals.activeMinutes) || 0;
  const exerciseMinutes = activities.reduce((sum, item) => sum + Math.round((Number(item?.duration) || 0) / 60000), 0);
  const restingHeartRate = Number(summary.restingHeartRate) || null;
  const takeaways = [];
  if (totalActiveZoneMinutes > 0) {
    takeaways.push(`You earned ${totalActiveZoneMinutes} active zone minutes.`);
  }
  if (activeMinutes > 0) {
    if (activeMinutesGoal > 0) takeaways.push(`You had ${activeMinutes} active minutes (goal ${activeMinutesGoal}).`);
    else takeaways.push(`You had ${activeMinutes} active minutes.`);
  }
  if (floors > 0 || floorsGoal > 0) {
    if (floorsGoal > 0) takeaways.push(`You climbed ${floors} floors (goal ${floorsGoal}).`);
    else if (floors > 0) takeaways.push(`You climbed ${floors} floors.`);
  }
  if (distanceMiles > 0) {
    const milesText = distanceMiles < 0.1 ? "under 0.1 miles" : `${distanceMiles.toFixed(1)} miles`;
    if (distanceGoal > 0) takeaways.push(`You walked ${milesText} (goal ${distanceGoal} mi).`);
    else takeaways.push(`You walked ${milesText}.`);
  }
  if (activities.length > 0 && exerciseMinutes > 0) {
    takeaways.push(`You logged ${activities.length} exercise session${activities.length === 1 ? "" : "s"} for about ${exerciseMinutes} minutes total.`);
  }
  if (topActivity?.name) takeaways.push(`${topActivity.name} was your main logged activity.`);
  if (Number.isFinite(stepGoalPct)) {
    if (stepGoalPct >= 100) takeaways.push(`You reached your step goal at about ${stepGoalPct} percent.`);
    else takeaways.push(`You reached about ${stepGoalPct} percent of your step goal.`);
  }
  if (dominantZone?.name && dominantZone?.minutes > 0) {
    takeaways.push(`Most heart-zone time was in ${dominantZone.name.toLowerCase()}.`);
  }
  if (activeZoneMinutes.length) {
    const topZones = activeZoneMinutes
      .slice()
      .sort((a, b) => b.minutes - a.minutes)
      .slice(0, 2)
      .map((zone) => `${zone.name || "active"} ${zone.minutes} minutes`)
      .join(", ");
    if (topZones) takeaways.push(`Active zone breakdown: ${topZones}.`);
  }
  if (restingHeartRate) takeaways.push(`Resting heart rate was ${restingHeartRate} beats per minute.`);
  return {
    steps,
    stepGoal,
    stepGoalPct,
    floors,
    floorsGoal,
    distanceMiles,
    distanceGoal,
    activeMinutes,
    activeMinutesGoal,
    totalActiveZoneMinutes,
    activeZoneMinutes,
    exerciseMinutes,
    caloriesOut: Number(summary.caloriesOut) || 0,
    activityCalories: Number(summary.activityCalories) || 0,
    sedentaryMinutes: Number(summary.sedentaryMinutes) || 0,
    restingHeartRate,
    topActivity,
    dominantZone,
    heartZones: heartZones.map((zone) => ({
      name: sanitizePlainText(zone?.name, 30, ""),
      minutes: Number(zone?.minutes) || 0,
      caloriesOut: Number(zone?.caloriesOut) || 0,
    })),
    takeaway: takeaways.join(" "),
  };
}

function buildSummaryBundle({ plan, fetched, userContext }) {
  qnaLog("summary", "buildSummaryBundle start", {
    primaryMetric: fetched.primaryMetric,
    secondaryMetric: fetched.secondaryMetric ?? null,
    metrics_needed: fetched.metrics_needed,
    primaryCurrentLength: fetched.primaryCurrent?.length ?? 0,
    secondaryCurrentLength: fetched.secondaryCurrent?.length ?? 0,
  });

  const metricSeriesMap = {};
  const metricStatsMap = {};
  const metricComparisonMap = {};
  const metricAnomaliesMap = {};
  const intradaySummaryMap = {};
  const intradayInsightsMap = {};
  const intradayAvailabilityMap = {};
  (fetched.metrics_needed || []).forEach((metricKey) => {
    const series = fetched.metricsData?.[metricKey]?.current || [];
    metricSeriesMap[metricKey] = series;
    metricStatsMap[metricKey] = calculateStats(series, getGoalForMetric(metricKey, userContext));
    metricComparisonMap[metricKey] = comparePeriods(fetched.metricsData?.[metricKey]?.all || [], fetched.primaryWindow.baseDays);
    metricAnomaliesMap[metricKey] = detectAnomalies(series).slice(0, 5);
    if (isIntradayMetric(metricKey)) {
      intradayAvailabilityMap[metricKey] = {
        intraday_status: fetched.metricsData?.[metricKey]?.intraday_status || "available",
        intraday_reason: fetched.metricsData?.[metricKey]?.intraday_reason || "",
        is_synthetic: Boolean(fetched.metricsData?.[metricKey]?.is_synthetic),
        data_quality_note: fetched.metricsData?.[metricKey]?.data_quality_note || "",
        source: fetched.metricsData?.[metricKey]?.source || "fitbit_intraday",
      };
      const intradaySummary = summarizeIntradayWindows(series);
      intradaySummaryMap[metricKey] = intradaySummary
        ? { ...intradaySummary, ...intradayAvailabilityMap[metricKey] }
        : null;
      const intradayInsights = summarizeIntradayFacts(series, intradaySummary);
      intradayInsightsMap[metricKey] = intradayInsights
        ? { ...intradayInsights, ...intradayAvailabilityMap[metricKey] }
        : null;
    }
  });

  const primaryMetric = fetched.primaryMetric;
  const primarySeries = fetched.primaryCurrent || [];
  const primaryStats = metricStatsMap[primaryMetric] || calculateStats([]);
  const numComparisonPeriods = Math.min(4, Math.max(2, Number(plan.num_comparison_periods) || 2));
  const useMultiPeriod = numComparisonPeriods > 2
    && (Boolean(plan.needs_previous_period) || plan.comparison_mode === "previous_period")
    && (fetched.primaryAll || []).length >= fetched.primaryWindow.baseDays * numComparisonPeriods;
  const multiPeriodResult = useMultiPeriod
    ? compareNPeriods(fetched.primaryAll || [], fetched.primaryWindow.baseDays, numComparisonPeriods)
    : null;
  const comparisonStats = multiPeriodResult
    ? {
        periods: multiPeriodResult.periods,
        changePct: multiPeriodResult.changePct,
        currentAvg: multiPeriodResult.currentAvg,
        earliestAvg: multiPeriodResult.earliestAvg,
        current: multiPeriodResult.periods[multiPeriodResult.periods.length - 1]?.points || [],
        previous: multiPeriodResult.periods[0]?.points || [],
        enoughHistory: multiPeriodResult.enoughHistory,
      }
    : (metricComparisonMap[primaryMetric] || comparePeriods(fetched.primaryAll || [], fetched.primaryWindow.baseDays));
  const anomalies = metricAnomaliesMap[primaryMetric] || detectAnomalies(primarySeries).slice(0, 5);
  const highlight = pickHighlight(primarySeries);
  const relationship = fetched.secondaryCurrent?.length
    ? describeRelationship(primarySeries, fetched.secondaryCurrent, {
      primaryMetricLabel: metricLabel(primaryMetric),
        secondaryMetricLabel: metricLabel(fetched.secondaryMetric),
      })
    : null;
  const weekdayWeekend = groupWeekdayWeekend(primarySeries);
  const strongestDay = strongestChangeDay(primarySeries);
  const goal = getGoalForMetric(primaryMetric, userContext);
  const aligned = alignSeriesMap(metricSeriesMap);
  const sleepRaw = fetched.metricsData?.sleep_minutes?.raw || (primaryMetric === "sleep_minutes" ? fetched.primaryRaw : null);
  const sleepSeriesBundle = sleepRaw ? toSleepSeries(sleepRaw, fetched.primaryWindow.windowDays) : null;
  const sleepStageBreakdown = sleepRaw ? toSleepStageBreakdown(sleepRaw) : null;
  const sleepStageComparison = sleepRaw ? toSleepStageComparison(sleepRaw) : null;
  const sleepTimingSummary = sleepRaw ? toSleepTimingSummary(sleepRaw) : null;
  const sleepStageTimeline = sleepRaw ? toSleepStageTimeline(sleepRaw) : null;
  const sleepStageTrendSeries = sleepRaw ? toSleepStageTrendSeries(sleepRaw, fetched.primaryWindow.windowDays) : null;
  const preferredIntradayMetric = intradayMetricForMetric(primaryMetric);
  const intradayAvailability = intradayAvailabilityMap[primaryMetric]
    || (preferredIntradayMetric ? intradayAvailabilityMap[preferredIntradayMetric] : null)
    || null;
  const intradayWindowSummary = intradaySummaryMap[primaryMetric]
    || (preferredIntradayMetric ? intradaySummaryMap[preferredIntradayMetric] : null)
    || (String(primaryMetric || "").endsWith("_intraday") ? summarizeIntradayWindows(primarySeries) : null);
  const intradayInsights = intradayInsightsMap[primaryMetric]
    || (preferredIntradayMetric ? intradayInsightsMap[preferredIntradayMetric] : null)
    || (String(primaryMetric || "").endsWith("_intraday") ? summarizeIntradayFacts(primarySeries, intradayWindowSummary) : null);
  const relationshipRankings = rankMetricRelationships(metricSeriesMap);
  const relationshipMap = {};
  relationshipRankings.forEach((item) => {
    relationshipMap[`${item.primaryMetric}|${item.secondaryMetric}`] = item;
    relationshipMap[`${item.secondaryMetric}|${item.primaryMetric}`] = {
      ...item,
      primaryMetric: item.secondaryMetric,
      secondaryMetric: item.primaryMetric,
    };
  });
  const reportFacts = {
    strongestMetricChange: Object.entries(metricComparisonMap)
      .map(([metricKey, stats]) => ({ metricKey, changePct: Math.abs(Number(stats?.changePct) || 0), direction: stats?.direction || "flat" }))
      .sort((a, b) => b.changePct - a.changePct)[0] || null,
    highestVariabilityMetric: Object.entries(metricStatsMap)
      .map(([metricKey, stats]) => ({ metricKey, variability: Number(stats?.variability) || 0 }))
      .sort((a, b) => b.variability - a.variability)[0] || null,
    strongestRelationship: relationshipRankings[0] || null,
  };
  const sleepQuality = summarizeSleepQuality({
    sleepSeries: sleepSeriesBundle?.sleep || [],
    efficiencySeries: sleepSeriesBundle?.efficiency || [],
    wakeSeries: sleepSeriesBundle?.wakeMinutes || [],
    bedtimeSeries: sleepSeriesBundle?.bedtimeClock || [],
    sleepTimingSummary,
    sleepStageBreakdown,
    sleepStageComparison,
  });
  const activitySummary = buildActivitySummaryFacts(fetched.contextData?.activitySummaryRaw || null);

  const chartContext = {
    requestMetric: primaryMetric,
    metricsShown: plan.metrics_needed,
    timeWindow: fetched.primaryWindow,
    visualFamily: plan.preferred_chart,
    highlight,
    anomalyCount: anomalies.length,
    progressiveViewsAvailable: 0,
    intradayAvailabilityMap,
    intraday_status: intradayAvailability?.intraday_status || null,
    intraday_reason: intradayAvailability?.intraday_reason || "",
    is_synthetic: Boolean(intradayAvailability?.is_synthetic),
    data_quality_note: intradayAvailability?.data_quality_note || "",
    source: intradayAvailability?.source || null,
  };

  const summaryBundle = {
    rawSeries: metricSeriesMap,
    normalizedSeries: aligned,
    currentPeriodStats: primaryStats,
    previousPeriodComparison: comparisonStats,
    anomalies,
    consistency: {
      variability: primaryStats.variability,
      consistencyScore: primaryStats.consistencyScore,
    },
    weekdayVsWeekend: weekdayWeekend,
    dayVsWeek: {
      currentDayValue: Number(primarySeries[primarySeries.length - 1]?.value || 0),
      weekAverage: primaryStats.avg,
      baselineComparisonPct: percentChange(primarySeries[primarySeries.length - 1]?.value || 0, primaryStats.avg || 0),
    },
    goalProgress: {
      goal,
      progressPct: primaryStats.goalProgressPct,
    },
    crossMetricRelationships: relationship,
    strongestChangeDay: strongestDay,
    baselineComparison: {
      deltaFromPreviousAverage: comparisonStats.baselineDelta,
      percentChange: comparisonStats.changePct,
    },
    groupedEffectSummaries: relationship?.groupedEffectSummary || null,
    metricComparisonMap,
    metricAnomaliesMap,
    intradaySummaryMap,
    intradayInsightsMap,
    intradayAvailabilityMap,
    intradayInsights,
    relationshipRankings,
    relationshipMap,
    reportFacts,
    chartContext,
    drillDownSuggestions: defaultSuggestedQuestions(primaryMetric, plan.question_type),
    storyCandidates: buildStoryCandidates({
    primaryMetric,
    primaryStats,
    comparisonStats,
    anomalies,
    relationship,
      sleepQuality,
      intradayInsights,
      reportFacts,
      activitySummary,
    }),
    sleepSeriesBundle,
    sleepStageBreakdown,
    sleepStageComparison,
    sleepStageTrendSeries,
    sleepTimingSummary,
    sleepStageTimeline,
    sleepQuality,
    activitySummary,
    intradayWindowSummary,
    metricStatsMap,
    primaryMetric,
    secondaryMetric: fetched.secondaryMetric,
    timeLabel: fetched.primaryWindow.timeframeLabel,
    unit: metricUnit(primaryMetric),
    metricsShown: plan.metrics_needed,
    timeWindow: fetched.primaryWindow,
    timeScope: plan.time_scope,
  };

  summaryBundle.chartContext.progressiveViewsAvailable = [
    summaryBundle.sleepStageBreakdown,
    summaryBundle.sleepStageComparison,
    summaryBundle.sleepStageTimeline,
    summaryBundle.crossMetricRelationships?.grouped?.length,
    summaryBundle.previousPeriodComparison?.current?.length,
    summaryBundle.intradayWindowSummary?.buckets?.length,
    summaryBundle.relationshipRankings?.length,
    (summaryBundle.metricsShown || []).length > 1,
  ].filter(Boolean).length;

  return summaryBundle;
}

function formatMetricValue(value, unit = "") {
  const n = Number(value);
  if (!Number.isFinite(n)) return unit ? `0 ${unit}` : "0";
  const rounded = Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 10) / 10;
  return unit ? `${rounded.toLocaleString()} ${unit}` : `${rounded.toLocaleString()}`;
}

function formatSleepDurationSpeech(hoursValue) {
  const totalMinutes = Math.max(0, Math.round((Number(hoursValue) || 0) * 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes} minutes`;
  if (minutes <= 0) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${hours} hour${hours === 1 ? "" : "s"} ${minutes} minutes`;
}

/**
 * Deterministic answer that the app can always fall back to.
 */
function buildMicroAnswer({ questionType, summaryBundle }) {
  const metric = summaryBundle.primaryMetric;
  const stats = summaryBundle.currentPeriodStats;
  const comparison = summaryBundle.previousPeriodComparison;
  const subject = metricLabel(metric);
  const timeLabel = summaryBundle.timeLabel;
  const intradayAvailability = summaryBundle.intradayAvailabilityMap?.[metric]
    || summaryBundle.intradayAvailabilityMap?.[intradayMetricForMetric(metric)]
    || null;
  const intradayEstimatePrefix = intradayAvailability?.is_synthetic
    ? "Fitbit did not provide minute-by-minute detail, so this is an estimated pattern based on your daily summary and logged activities. "
    : "";

  if (questionType === "relationship_report" && summaryBundle.crossMetricRelationships?.statement) {
    return compressAlexaSpeech(summaryBundle.crossMetricRelationships.statement);
  }
  if (intradayAvailability?.is_synthetic
    && ["single_metric_status", "chart_explanation", "anomaly_explanation"].includes(questionType)
    && summaryBundle.intradayInsights?.takeaway
    && isSingleDayScope(summaryBundle.timeScope)
    && (String(metric).endsWith("_intraday") || intradayMetricForMetric(metric))) {
    return compressAlexaSpeech(`${intradayEstimatePrefix}${summaryBundle.intradayInsights.takeaway}`);
  }
  if (summaryBundle.activitySummary?.takeaway
    && ["steps", "calories", "distance", "floors", "elevation", "resting_hr"].includes(baseMetricForIntraday(metric))) {
    return compressAlexaSpeech(summaryBundle.activitySummary.takeaway);
  }
  if (["single_metric_status", "chart_explanation", "anomaly_explanation"].includes(questionType)
    && summaryBundle.intradayInsights?.takeaway
    && isSingleDayScope(summaryBundle.timeScope)
    && (String(metric).endsWith("_intraday") || intradayMetricForMetric(metric))) {
    return compressAlexaSpeech(summaryBundle.intradayInsights.takeaway);
  }
  if (questionType === "goal_progress" && Number.isFinite(stats.goalProgressPct)) {
    return compressAlexaSpeech(`You are at about ${stats.goalProgressPct} percent of your ${subject} goal.`);
  }
  if (questionType === "comparison_report") {
    const direction = comparison.changePct > 3 ? "higher" : comparison.changePct < -3 ? "lower" : "about the same";
    return compressAlexaSpeech(`Your ${subject} was ${direction} than the previous period over ${timeLabel}.`);
  }
  if (questionType === "overview_report") {
    return compressAlexaSpeech(summaryBundle.storyCandidates[0] || `Here is your overall summary for ${timeLabel}.`);
  }
  if (["sleep_minutes", "sleep_efficiency", "wake_minutes"].includes(metric) && summaryBundle.sleepQuality?.takeaway) {
    return compressAlexaSpeech(summaryBundle.sleepQuality.takeaway);
  }
  if (metric === "sleep_minutes") {
    return compressAlexaSpeech(`You slept about ${formatSleepDurationSpeech(stats.current || stats.avg)} for ${timeLabel}.`);
  }
  return compressAlexaSpeech(`Your ${subject} was about ${formatMetricValue(stats.current || stats.avg, summaryBundle.unit)} for ${timeLabel}.`);
}

function buildPanelId(goal, metrics = []) {
  return sanitizePlainText(`${goal}_${metrics.join("_")}`, 64, goal || "panel").replace(/[^a-z0-9_]+/gi, "_").toLowerCase();
}

function inferVisualForGoal(goal, metrics = [], plan = {}) {
  if (goal === "goal_progress") return "gauge";
  if (goal === "relationship_report") return "scatter";
  if (goal === "comparison_report") return plan.needs_intraday ? "area" : "grouped_bar";
  if (goal === "chart_explanation" && plan.needs_intraday) return "timeline";
  if (goal === "anomaly_explanation" && plan.needs_intraday) return "area";
  if (goal === "overview_report" && metrics.length > 1) return "composed_summary";
  if (goal === "deep_dive" && metrics.includes("sleep_minutes")) return "timeline";
  if (goal === "single_metric_status" && metrics.some((metric) => String(metric).endsWith("_intraday"))) return "area";
  return plan.preferred_chart || "line";
}

function pickLayoutForPanelCount(responseMode, panelCount, requestedLayout = "") {
  if (responseMode === "single_view") return "single_focus";
  const count = Math.max(1, Math.min(4, Number(panelCount) || 1));
  if (VISUAL_SYSTEM.allowed.layouts.includes(requestedLayout)) {
    if (requestedLayout === "single_focus" && count > 1) return count === 2 ? "two_up" : count === 3 ? "two_up_plus_footer" : "four_panel_grid";
    if (requestedLayout === "two_up" && count !== 2) return count === 3 ? "two_up_plus_footer" : count >= 4 ? "four_panel_grid" : "single_focus";
    if ((requestedLayout === "two_up_plus_footer" || requestedLayout === "three_panel_report") && count !== 3) {
      return count >= 4 ? "four_panel_grid" : count === 2 ? "two_up" : "single_focus";
    }
    if (requestedLayout === "four_panel_grid" && count < 4) {
      return count === 3 ? "two_up_plus_footer" : count === 2 ? "two_up" : "single_focus";
    }
    return requestedLayout;
  }
  if (count >= 4) return "four_panel_grid";
  if (count === 3) return "two_up_plus_footer";
  if (count === 2) return "two_up";
  return "single_focus";
}

function buildPanelTitle(goal, metrics, summaryBundle) {
  const labels = metrics.map((metric) => toTitleCase(metricLabel(metric)));
  if (metrics.includes("sleep_minutes") && goal === "deep_dive") return "Sleep quality detail";
  if (metrics.some((metric) => String(metric).endsWith("_intraday")) && goal === "single_metric_status") {
    return `${labels[0] || "Metric"} through the day`;
  }
  if (goal === "comparison_report") return `${labels[0] || "Metric"} vs previous`;
  if (goal === "relationship_report") return `${labels[0] || "Metric"} and ${labels[1] || "metric"}`;
  if (goal === "goal_progress") return `${labels[0] || "Metric"} goal progress`;
  if (goal === "chart_explanation") return `${labels[0] || "Metric"} explained`;
  if (goal === "anomaly_explanation") return `${labels[0] || "Metric"} standout pattern`;
  if (goal === "deep_dive") return `${labels[0] || "Metric"} detail`;
  if (goal === "overview_report" && metrics.length > 1) return "Coordinated trends";
  return `${labels[0] || "Metric"} summary`;
}

function buildPanelSubtitle(goal, summaryBundle) {
  if (goal === "comparison_report") return `${summaryBundle.timeLabel} compared with the previous period`;
  if (goal === "relationship_report") return `Relationship across ${summaryBundle.timeLabel}`;
  if (summaryBundle.timeScope && isSingleDayScope(summaryBundle.timeScope)) return `${summaryBundle.timeLabel} detail`;
  return summaryBundle.timeLabel;
}

function supportsIntradayView(summaryBundle, metrics = []) {
  return metrics.some((metricKey) => {
    const directMetric = String(metricKey || "");
    const intradayMetric = intradayMetricForMetric(metricKey);
    return Boolean(summaryBundle.intradaySummaryMap?.[directMetric] || summaryBundle.intradaySummaryMap?.[intradayMetric]);
  });
}

function getVisualAlternatives(goal, metrics = [], plan = {}, summaryBundle = {}) {
  const includesSleep = metrics.includes("sleep_minutes");
  const includesSleepMetric = metrics.some((metric) => ["sleep_minutes", "sleep_efficiency", "wake_minutes"].includes(metric));
  const includesIntraday = metrics.some((metric) => String(metric).endsWith("_intraday"))
    || (isSingleDayScope(plan.time_scope) && supportsIntradayView(summaryBundle, metrics));
  const hasRelationship = metrics.length > 1 && Boolean(summaryBundle.relationshipMap?.[`${metrics[0]}|${metrics[1]}`] || summaryBundle.crossMetricRelationships);
  const singleDaySleep = includesSleep && isSingleDayScope(plan.time_scope);
  const hasSleepStageTimeline = includesSleep && Array.isArray(summaryBundle.sleepStageTimeline) && summaryBundle.sleepStageTimeline.length > 0;

  if (goal === "goal_progress") return ["gauge", "bar", "line"];
  if (goal === "relationship_report") {
    return hasRelationship && summaryBundle.crossMetricRelationships?.grouped?.length
      ? ["grouped_bar", "scatter", "multi_line"]
      : ["multi_line","grouped_bar", "scatter", "line"];
  }
  if (goal === "comparison_report") {
    return includesIntraday
      ? ["area", "line", "grouped_bar"]
      : ["grouped_bar", "line", "area"];
  }
  if (goal === "chart_explanation") {
    if (includesSleep) {
      const choices = [];
      if (hasSleepStageTimeline) choices.push("timeline");
      if (summaryBundle.sleepStageBreakdown?.length) choices.push("pie");
      choices.push("line", "bar", "area");
      return [...new Set(choices)];
    }
    if (includesIntraday) return ["timeline", "area", "bar", "line"];
    return ["line", "bar", "area"];
  }
  if (goal === "anomaly_explanation") {
    const baseChoices = includesIntraday ? ["heatmap", "area", "timeline", "line", "bar"] : ["heatmap", "line", "area", "bar"];
    return baseChoices;
  }
  if (goal === "deep_dive") {
    if (includesSleep) {
      const choices = [];
      if (hasSleepStageTimeline) choices.push("timeline");
      if (summaryBundle.sleepStageBreakdown?.length) choices.push("pie");
      choices.push("line", "bar", "area");
      return [...new Set(choices)];
    }
    if (includesIntraday) return ["timeline", "area", "bar", "line"];
    if (metrics.length > 1) return ["multi_line", "scatter", "radar", "line", "bar"];
    const labelCount = summaryBundle.normalizedSeries?.labels?.length ?? 0;
    if (labelCount >= 7) return ["heatmap", "line", "bar", "area"];
    return ["line", "bar", "area"];
  }
  if (goal === "overview_report") {
    if (metrics.length >= 3) return ["radar", "composed_summary", "multi_line", "line", "area"];
    if (metrics.length > 1) return ["composed_summary", "multi_line", "radar", "line", "area"];
    return includesIntraday ? ["area", "line", "bar"] : ["line", "bar", "area"];
  }
  if (goal === "single_metric_status") {
    if (includesSleepMetric) {
      const choices = [];
      if (singleDaySleep && hasSleepStageTimeline) choices.push("timeline");
      if (includesSleep && summaryBundle.sleepStageBreakdown?.length) choices.push("pie");
      choices.push("line", "bar", "area");
      return [...new Set(choices)];
    }
    if (includesIntraday) return ["area", "timeline", "line", "bar"];
    const labelCount = summaryBundle.normalizedSeries?.labels?.length ?? 0;
    if (labelCount >= 5) return ["heatmap", "line", "bar", "area"];
    const base = ["line", "bar", "area"];
    const rot = ((metrics?.length || 0) + (summaryBundle.normalizedSeries?.labels?.length || 0)) % 3;
    if (!rot) return base;
    return base.slice(rot).concat(base.slice(0, rot));
  }
  const fallbackBase = ["line", "bar", "area"];
  const rot = (metrics?.length || 0) % 3;
  const first = plan.preferred_chart || fallbackBase[rot];
  return [first, ...fallbackBase.filter((t) => t !== first)];
}

function chooseVisualFamily(goal, metrics, plan, summaryBundle, usedVisuals = new Set()) {
  const choices = getVisualAlternatives(goal, metrics, plan, summaryBundle)
    .filter((visual) => VISUAL_SYSTEM.allowed.chartTypes.includes(visual));
  return choices.find((visual) => !usedVisuals.has(visual)) || choices[0] || inferVisualForGoal(goal, metrics, plan);
}

function rotateArray(values = [], offset = 0) {
  const arr = Array.isArray(values) ? values.filter(Boolean) : [];
  if (!arr.length) return [];
  const shift = ((Number(offset) || 0) % arr.length + arr.length) % arr.length;
  return arr.slice(shift).concat(arr.slice(0, shift));
}

function applyPanelContrastTheme(chartSpec, panel, panelIndex = 0, panelCount = 1) {
  if (!chartSpec || typeof chartSpec !== "object") return chartSpec;
  const isPie = chartSpec.chart_type === "pie";
  const paletteKey = panel?.palette_key || panel?.metrics?.[0] || "fallback";
  const palette = metricToPalette(paletteKey);
  const paletteSeries = palette.series || [palette.primary, palette.secondary, palette.accent];
  const rotatedSeries = rotateArray(paletteSeries, panelCount > 1 ? panelIndex : 0);
  const accentColor = rotatedSeries[0] || palette.primary;
  const secondaryAccent = rotatedSeries[1] || palette.secondary;
  const nextOption = {
    ...(chartSpec.option || {}),
    color: isPie ? (chartSpec.option?.color || rotatedSeries) : rotatedSeries,
  };
  if (Array.isArray(nextOption.series)) {
    nextOption.series = nextOption.series.map((series, seriesIndex) => {
      const stroke = rotatedSeries[seriesIndex % rotatedSeries.length] || accentColor;
      const keepPieColors = isPie && series.type === "pie";
      return {
        ...series,
        itemStyle: keepPieColors
          ? (series?.itemStyle || {})
          : {
              ...(series?.itemStyle || {}),
              color: series?.itemStyle?.color || stroke,
            },
        lineStyle: series?.type === "line" || series?.type === "scatter"
          ? {
              ...(series?.lineStyle || {}),
              color: series?.lineStyle?.color || stroke,
            }
          : series?.lineStyle,
        areaStyle: series?.areaStyle
          ? {
              ...(series?.areaStyle || {}),
              color: series?.areaStyle?.color || secondaryAccent,
            }
          : series?.areaStyle,
      };
    });
  }
  return {
    ...chartSpec,
    option: nextOption,
    panel_theme: {
      accentColor,
      secondaryAccent,
      borderColor: `${accentColor}33`,
      backgroundColor: palette.background,
      textColor: palette.text,
    },
  };
}

function buildNextView(id, label, goal, metrics, extras = {}) {
  return {
    id: sanitizePlainText(id, 64, "next_view").replace(/[^a-z0-9_]+/gi, "_").toLowerCase(),
    label: sanitizePlainText(label, 40, "More detail"),
    goal,
    metrics: metrics.slice(0, 4),
    ...extras,
  };
}

function buildDefaultReportPlan(question, plan, summaryBundle) {
  const primaryMetric = summaryBundle.primaryMetric;
  const metrics = Array.isArray(summaryBundle.metricsShown) && summaryBundle.metricsShown.length
    ? summaryBundle.metricsShown
    : [primaryMetric];
  const strongestRelationship = summaryBundle.reportFacts?.strongestRelationship || summaryBundle.relationshipRankings?.[0] || null;
  const takeaway = summaryBundle.storyCandidates[0] || `Here is your summary for ${summaryBundle.timeLabel}.`;
  const spoken = buildMicroAnswer({ questionType: plan.question_type, summaryBundle });
  const isSingle = plan.response_mode === "single_view"
    || ["single_metric_status", "goal_progress", "chart_explanation", "anomaly_explanation"].includes(plan.question_type);
  const panels = [];
  const usedVisuals = new Set();
  const pushPanel = (goal, panelMetrics, requestedVisual = null, extras = {}) => {
    const metricsForPanel = panelMetrics.map(normalizeMetric).filter(Boolean).slice(0, 4);
    if (!metricsForPanel.length) return;
    const panel_id = buildPanelId(goal, metricsForPanel);
    if (panels.some((panel) => panel.panel_id === panel_id)) return;
    const visualFamily = requestedVisual && VISUAL_SYSTEM.allowed.chartTypes.includes(requestedVisual)
      ? requestedVisual
      : chooseVisualFamily(goal, metricsForPanel, plan, summaryBundle, usedVisuals);
    usedVisuals.add(visualFamily);
    panels.push({
      panel_id,
      goal,
      metrics: metricsForPanel,
      visual_family: visualFamily,
      title: buildPanelTitle(goal, metricsForPanel, summaryBundle),
      subtitle: buildPanelSubtitle(goal, summaryBundle),
      emphasis: extras.emphasis || "standard",
    });
  };

  const primaryDisplayMetric = isSingleDayScope(plan.time_scope)
    ? intradayMetricForMetric(primaryMetric) || primaryMetric
    : primaryMetric;
  const sleepMetricsAvailable = (summaryBundle.metricsShown || []).filter((m) => ["sleep_minutes", "sleep_efficiency", "wake_minutes"].includes(m));
  const sleepDisplayMetrics = sleepMetricsAvailable.length ? sleepMetricsAvailable : ["sleep_minutes"];
  const sleepStageMetric = sleepMetricsAvailable.includes("sleep_minutes")
    ? ["sleep_minutes"]
    : sleepDisplayMetrics.slice(0, 1);
  const hasSleepStageTimeline = Array.isArray(summaryBundle.sleepStageTimeline) && summaryBundle.sleepStageTimeline.length > 0;

  if (isSingle) {
    const singleMetrics = metrics.slice(0, Math.max(1, plan.comparison_mode === "metric_vs_metric" ? 2 : 1));
    const scopedMetrics = singleMetrics.length === 1 && isSingleDayScope(plan.time_scope)
      ? [intradayMetricForMetric(singleMetrics[0]) || singleMetrics[0]]
      : singleMetrics;
    const visual = chooseVisualFamily(plan.question_type, scopedMetrics, plan, summaryBundle, usedVisuals);
    pushPanel(plan.question_type, scopedMetrics, visual, { emphasis: "hero" });

    const hasSleepMetric = metrics.some((m) => ["sleep_minutes", "sleep_efficiency", "wake_minutes"].includes(m));
    if (hasSleepMetric && sleepStageMetric.length && panels.length < 2) {
      if (hasSleepStageTimeline) pushPanel("deep_dive", sleepStageMetric, "timeline", { emphasis: "standard" });
      else if (summaryBundle.sleepStageBreakdown?.length) pushPanel("deep_dive", sleepStageMetric, "pie", { emphasis: "standard" });
    }
    if (Number.isFinite(summaryBundle.goalProgress?.progressPct) && panels.length < 4) {
      pushPanel("goal_progress", [primaryMetric], "gauge", { emphasis: "standard" });
    }
    if (summaryBundle.previousPeriodComparison?.current?.length && panels.length < 4) {
      pushPanel("comparison_report", [primaryMetric], "line", { emphasis: "standard" });
    }
  } else {
    pushPanel("overview_report", metrics.slice(0, Math.min(4, metrics.length)), "composed_summary", { emphasis: "hero" });

    const strongestChangeMetric = summaryBundle.reportFacts?.strongestMetricChange?.metricKey
      || metrics.find((metricKey) => summaryBundle.metricComparisonMap?.[metricKey]?.enoughHistory)
      || primaryMetric;
    if (strongestChangeMetric && panels.length < 4) {
      pushPanel("comparison_report", [strongestChangeMetric], null, { emphasis: "standard" });
    }
    if (strongestRelationship?.primaryMetric && strongestRelationship?.secondaryMetric && panels.length < 4) {
      pushPanel("relationship_report", [strongestRelationship.primaryMetric, strongestRelationship.secondaryMetric], "scatter", { emphasis: "standard" });
    }
    if (summaryBundle.sleepQuality && metrics.some((m) => ["sleep_minutes", "sleep_efficiency", "wake_minutes"].includes(m)) && panels.length < 4) {
      pushPanel(
        "deep_dive",
        sleepStageMetric.length ? sleepStageMetric : sleepDisplayMetrics,
        hasSleepStageTimeline ? "timeline" : (summaryBundle.sleepStageBreakdown?.length ? "pie" : null),
        { emphasis: "standard" },
      );
    }
    if (summaryBundle.metricAnomaliesMap?.[primaryMetric]?.length && panels.length < 4) {
      pushPanel("anomaly_explanation", [primaryDisplayMetric], "area", { emphasis: "standard" });
    }
    if (Number.isFinite(summaryBundle.goalProgress?.progressPct) && panels.length < 4) {
      pushPanel("goal_progress", [primaryMetric], "gauge", { emphasis: "standard" });
    }
  }

  const trimmedPanels = prioritizeTimelinePanelForThreePanelView(panels.slice(0, isSingle ? 1 : 4));
  const next_views = [];
  if (sleepStageMetric.length && (hasSleepStageTimeline || summaryBundle.sleepStageBreakdown?.length)) {
    next_views.push(buildNextView("sleep_detail", "Sleep detail", "deep_dive", sleepStageMetric, {
      visual_family: hasSleepStageTimeline ? "timeline" : "pie",
    }));
  }
  if (summaryBundle.intradayInsights && (intradayMetricForMetric(primaryMetric) || String(primaryMetric).endsWith("_intraday"))) {
    next_views.push(buildNextView("intraday_detail", "Intraday detail", "chart_explanation", [intradayMetricForMetric(primaryMetric) || primaryMetric], {
      visual_family: "timeline",
    }));
  }
  if (strongestRelationship?.primaryMetric && strongestRelationship?.secondaryMetric) {
    next_views.push(buildNextView("relationship_detail", "Relationship detail", "relationship_report", [strongestRelationship.primaryMetric, strongestRelationship.secondaryMetric], { visual_family: "scatter" }));
  }
  metrics.slice(0, 2).forEach((metricKey) => {
    const detailMetric = isSingleDayScope(plan.time_scope) ? intradayMetricForMetric(metricKey) || metricKey : metricKey;
    next_views.push(buildNextView(`${metricKey}_detail`, `${toTitleCase(metricLabel(metricKey))} detail`, "deep_dive", [detailMetric], {
      visual_family: inferVisualForGoal("deep_dive", [detailMetric], plan),
    }));
  });

  return {
    response_mode: isSingle ? "single_view" : "multi_panel_report",
    layout: pickLayoutForPanelCount(isSingle ? "single_view" : "multi_panel_report", trimmedPanels.length, plan.layout_hint),
    spoken_answer: spoken,
    report_title: isSingle
      ? `${toTitleCase(metricLabel(primaryMetric))} summary`
      : detectOverviewIntent(question) ? "Your health at a glance" : "Health report",
    takeaway: sanitizePlainText(takeaway, 220, "Here is your summary."),
    panels: trimmedPanels,
    next_views: next_views.filter((view, index, arr) => arr.findIndex((item) => item.id === view.id) === index).slice(0, 4),
    suggested_followup_prompt: next_views.length
      ? `Say "${next_views[0].label.toLowerCase()}" or "show more" for details.`
      : "Say show more for details.",
    followup_mode: plan.followup_mode || "suggested_drill_down",
  };
}

function prioritizeTimelinePanelForThreePanelView(panels = []) {
  if (!Array.isArray(panels) || panels.length !== 3) return Array.isArray(panels) ? panels : [];
  const timelineIndex = panels.findIndex((panel) => panel?.visual_family === "timeline");
  if (timelineIndex === -1) return panels;
  const reordered = panels.slice();
  if (timelineIndex > 0) {
    const [timelinePanel] = reordered.splice(timelineIndex, 1);
    reordered.unshift(timelinePanel);
  }
  return reordered.map((panel, index) => ({
    ...panel,
    emphasis: index === 0 ? "hero" : "standard",
  }));
}

function normalizePresentationPlan(rawPlan, fallbackPlan) {
  const plan = rawPlan && typeof rawPlan === "object" ? rawPlan : {};
  const panels = Array.isArray(plan.panels) ? plan.panels : [];
  const normalizedPanels = panels.map((panel, index) => ({
    panel_id: sanitizePlainText(panel?.panel_id, 64, fallbackPlan.panels[index]?.panel_id || `panel_${index + 1}`).replace(/[^a-z0-9_]+/gi, "_").toLowerCase(),
    goal: VISUAL_SYSTEM.allowed.reportGoals.includes(panel?.goal) ? panel.goal : (fallbackPlan.panels[index]?.goal || fallbackPlan.panels[0]?.goal || "single_metric_status"),
    metrics: Array.isArray(panel?.metrics)
      ? panel.metrics.map(normalizeMetric).filter(Boolean).slice(0, 4)
      : (fallbackPlan.panels[index]?.metrics || fallbackPlan.panels[0]?.metrics || [fallbackPlan.panels[0]?.metrics?.[0] || "steps"]),
    visual_family: VISUAL_SYSTEM.allowed.chartTypes.includes(panel?.visual_family)
      ? panel.visual_family
      : (fallbackPlan.panels[index]?.visual_family || "bar"),
    title: sanitizePlainText(panel?.title, 80, fallbackPlan.panels[index]?.title || "Health panel"),
    subtitle: sanitizePlainText(panel?.subtitle, 120, fallbackPlan.panels[index]?.subtitle || fallbackPlan.report_title),
    emphasis: panel?.emphasis === "hero" ? "hero" : "standard",
  })).filter((panel) => panel.metrics.length);
  const chosenPanels = prioritizeTimelinePanelForThreePanelView(
    normalizedPanels.length ? normalizedPanels.slice(0, 4) : fallbackPlan.panels
  );
  const nextViews = Array.isArray(plan.next_views) ? plan.next_views : [];
  const normalizedNextViews = nextViews.map((view, index) => ({
    id: sanitizePlainText(view?.id, 64, fallbackPlan.next_views[index]?.id || `next_view_${index + 1}`).replace(/[^a-z0-9_]+/gi, "_").toLowerCase(),
    label: sanitizePlainText(view?.label, 40, fallbackPlan.next_views[index]?.label || "More detail"),
    goal: VISUAL_SYSTEM.allowed.reportGoals.includes(view?.goal) ? view.goal : (fallbackPlan.next_views[index]?.goal || "deep_dive"),
    metrics: Array.isArray(view?.metrics)
      ? view.metrics.map(normalizeMetric).filter(Boolean).slice(0, 4)
      : (fallbackPlan.next_views[index]?.metrics || [fallbackPlan.panels[0]?.metrics?.[0] || "steps"]),
  })).filter((view) => view.metrics.length);

  return {
    response_mode: VISUAL_SYSTEM.allowed.responseModes.includes(plan.response_mode) ? plan.response_mode : fallbackPlan.response_mode,
    layout: pickLayoutForPanelCount(
      VISUAL_SYSTEM.allowed.responseModes.includes(plan.response_mode) ? plan.response_mode : fallbackPlan.response_mode,
      chosenPanels.length,
      VISUAL_SYSTEM.allowed.layouts.includes(plan.layout) ? plan.layout : fallbackPlan.layout
    ),
    spoken_answer: compressAlexaSpeech(plan.spoken_answer, fallbackPlan.spoken_answer),
    report_title: sanitizePlainText(plan.report_title, 80, fallbackPlan.report_title),
    takeaway: sanitizePlainText(plan.takeaway, 220, fallbackPlan.takeaway),
    panels: chosenPanels,
    next_views: normalizedNextViews.length ? normalizedNextViews.slice(0, 4) : fallbackPlan.next_views,
    suggested_followup_prompt: sanitizePlainText(plan.suggested_followup_prompt, 120, fallbackPlan.suggested_followup_prompt),
    followup_mode: VISUAL_SYSTEM.allowed.followupModes.includes(plan.followup_mode) ? plan.followup_mode : fallbackPlan.followup_mode,
  };
}

async function maybeBuildPresentation(question, plan, summaryBundle, userContext, timeoutMs = PRESENT_CONFIG.timeoutMs, debug = null) {
  qnaLog("present", "requesting GPT presentation intent", {
    question,
    question_type: plan.question_type,
    metrics: plan.metrics_needed,
  });

  const fallback = buildDefaultReportPlan(question, plan, summaryBundle);
  const parsed = await callOpenAIJson({
    systemPrompt: PRESENT_CONFIG.systemPrompt,
    userPayload: {
      question,
      plan,
    userContext: {
      age: userContext?.age || null,
        healthGoals: userContext?.healthGoals || [],
      },
      summaryBundle: {
        primaryMetric: summaryBundle.primaryMetric,
        secondaryMetric: summaryBundle.secondaryMetric,
        metricsShown: summaryBundle.metricsShown,
        timeLabel: summaryBundle.timeLabel,
        unit: summaryBundle.unit,
        currentPeriodStats: summaryBundle.currentPeriodStats,
        previousPeriodComparison: summaryBundle.previousPeriodComparison,
        anomalies: summaryBundle.anomalies,
        consistency: summaryBundle.consistency,
        goalProgress: summaryBundle.goalProgress,
        crossMetricRelationships: summaryBundle.crossMetricRelationships,
        weekdayVsWeekend: summaryBundle.weekdayVsWeekend,
        strongestChangeDay: summaryBundle.strongestChangeDay,
        groupedEffectSummaries: summaryBundle.groupedEffectSummaries,
        sleepTimingSummary: summaryBundle.sleepTimingSummary,
        sleepStageBreakdown: summaryBundle.sleepStageBreakdown,
        sleepStageComparison: summaryBundle.sleepStageComparison,
        sleepStageTimeline: summaryBundle.sleepStageTimeline,
        sleepQuality: summaryBundle.sleepQuality,
        intradayWindowSummary: summaryBundle.intradayWindowSummary,
        intradayInsights: summaryBundle.intradayInsights,
        activitySummary: summaryBundle.activitySummary,
        relationshipRankings: summaryBundle.relationshipRankings,
        reportFacts: summaryBundle.reportFacts,
        availableDerivedViews: {
          hasSleepStageBreakdown: Boolean(summaryBundle.sleepStageBreakdown?.length),
          hasSleepStageComparison: Boolean(summaryBundle.sleepStageComparison?.length),
          hasSleepStageTimeline: Boolean(summaryBundle.sleepStageTimeline?.length),
          hasSleepStageTrend: Boolean(summaryBundle.sleepStageTrendSeries && Object.keys(summaryBundle.sleepStageTrendSeries).length > 0),
          hasActivitySummary: Boolean(summaryBundle.activitySummary?.takeaway || summaryBundle.activitySummary?.heartZones?.length),
          hasGoalProgress: Number.isFinite(summaryBundle.goalProgress?.progressPct),
          hasHeartZones: Boolean(summaryBundle.activitySummary?.heartZones?.length),
          hasIntradayWindows: Boolean(summaryBundle.intradayWindowSummary?.buckets?.length),
          hasRelationshipBuckets: Boolean(summaryBundle.crossMetricRelationships?.grouped?.length),
          hasPreviousPeriodBars: Boolean(summaryBundle.previousPeriodComparison?.current?.length),
          hasMultiMetricTrend: (summaryBundle.metricsShown || []).length > 1,
        },
        storyCandidates: summaryBundle.storyCandidates,
        chartContext: summaryBundle.chartContext,
      },
    },
      model: PRESENT_CONFIG.model,
      maxTokens: PRESENT_CONFIG.maxTokens,
      temperature: PRESENT_CONFIG.temperature,
      timeoutMs,
      jsonSchema: PRESENT_CONFIG.jsonSchema,
    onTrace: (trace) => recordTrace(debug, "presenter", trace, false),
  });

  if (!parsed) {
    qnaWarn("present", "GPT presentation unavailable, using deterministic fallback");
    if (debug?.gpt_trace?.presenter) debug.gpt_trace.presenter.used_fallback = true;
    else recordTrace(debug, "presenter", {
      status: "fallback",
      request_summary: summarizeForTrace({ question, plan }),
      response_summary: "Deterministic report plan used",
      error_message: "Presentation planner unavailable",
    }, true);
    return fallback;
  }

  return normalizePresentationPlan(parsed, fallback);
}

function seriesToLine(metricKey, values) {
  const palette = metricToPalette(metricKey);
  return {
    type: "line",
    name: toTitleCase(metricLabel(metricKey)),
    data: values,
    smooth: false,
    symbolSize: 7,
    lineStyle: { width: VISUAL_SYSTEM.chartDefaults.lineWidth, color: palette.primary },
    itemStyle: { color: palette.primary },
  };
}

function buildOverviewCards(summaryBundle) {
  const metrics = Array.isArray(summaryBundle.metricsShown) && summaryBundle.metricsShown.length
    ? summaryBundle.metricsShown
    : [summaryBundle.primaryMetric];
  return metrics.slice(0, 4).map((metricKey) => {
    const stats = summaryBundle.metricStatsMap?.[metricKey] || {};
  return {
      label: toTitleCase(metricLabel(metricKey)),
      value: metricKey === "sleep_minutes"
        ? formatSleepDurationSpeech(stats.current || stats.avg)
        : formatMetricValue(stats.current || stats.avg, metricUnit(metricKey)),
      subvalue: Number.isFinite(stats.goalProgressPct) ? `${stats.goalProgressPct}% of goal` : "",
    };
  });
}

function buildOverviewComposedSpec({ plan, summaryBundle, presentation, labels, primaryValues, base }) {
  const cards = buildOverviewCards(summaryBundle);
  const stories = sanitizeListText(summaryBundle.storyCandidates, 3, 120);
  const graphic = [];
  graphic.push({
    type: "text",
    left: "4%",
    top: 12,
    style: {
      text: presentation.chart_takeaway,
      fontSize: 18,
      fontWeight: 700,
      width: 700,
      lineHeight: 24,
      fill: "#0F172A",
    },
  });
  cards.forEach((card, idx) => {
    const left = `${4 + (idx * 23)}%`;
    graphic.push({
      type: "group",
      left,
      top: 58,
      children: [
        {
          type: "rect",
          shape: { x: 0, y: 0, width: 160, height: 74, r: 12 },
          style: { fill: "#F8FAFC", stroke: "#E2E8F0", lineWidth: 1 },
        },
        {
          type: "text",
          left: 12,
          top: 12,
          style: { text: card.label, fontSize: 13, fontWeight: 600, fill: "#475569" },
        },
        {
          type: "text",
          left: 12,
          top: 34,
          style: { text: card.value, fontSize: 20, fontWeight: 700, fill: "#0F172A" },
        },
        {
          type: "text",
          left: 12,
          top: 58,
          style: { text: card.subvalue || "", fontSize: 12, fill: "#64748B" },
        },
      ],
    });
  });
  stories.forEach((story, idx) => {
    graphic.push({
      type: "text",
      left: "4%",
      top: 152 + (idx * 24),
      style: {
        text: `- ${story}`,
        fontSize: 13,
        width: 760,
        lineHeight: 20,
        fill: "#334155",
      },
    });
  });

  return validateChartSpec({
    ...base,
    chart_type: "composed_summary",
    option: {
      items: [presentation.chart_takeaway, ...stories].slice(0, 4),
      cards,
      grid: { left: 44, right: 22, top: 248, bottom: 42 },
      xAxis: { type: "category", data: labels, axisTick: { show: false } },
      yAxis: { type: "value", name: summaryBundle.unit, splitLine: { lineStyle: { type: "dashed" } } },
      series: [{
        ...seriesToLine(summaryBundle.primaryMetric, primaryValues),
        smooth: true,
        areaStyle: { opacity: 0.1 },
      }],
      graphic,
    },
  }, base.title);
}

function buildRelationshipScatterSpec({ summaryBundle, base }) {
  const primaryValues = summaryBundle.normalizedSeries.valuesByMetric?.[summaryBundle.primaryMetric] || [];
  const secondaryValues = summaryBundle.normalizedSeries.valuesByMetric?.[summaryBundle.secondaryMetric] || [];
  const data = primaryValues
    .map((value, idx) => [value, secondaryValues[idx], summaryBundle.normalizedSeries.labels[idx]])
    .filter((pair) => Number.isFinite(pair[0]) && Number.isFinite(pair[1]));
  const relationship = summaryBundle.crossMetricRelationships || {};
  const corr = Number(relationship.correlation || 0);
  const palettePrimary = metricToPalette(summaryBundle.primaryMetric);
  const paletteSecondary = metricToPalette(summaryBundle.secondaryMetric);
  const colorPrimary = palettePrimary.primary;
  const colorSecondary = paletteSecondary.primary;
  return validateChartSpec({
    ...base,
    chart_type: "scatter",
    subtitle: `${base.subtitle}${base.subtitle ? " | " : ""}Correlation ${corr.toFixed(1)}`,
    takeaway: relationship.statement || base.takeaway,
    option: {
      color: [colorPrimary, colorSecondary],
      grid: { left: 56, right: 24, top: 56, bottom: 52 },
      tooltip: {
        trigger: "item",
        formatter: (params) => `${params.value[2] || "Day"}<br/>${metricLabel(summaryBundle.primaryMetric)}: ${params.value[0]}<br/>${metricLabel(summaryBundle.secondaryMetric)}: ${params.value[1]}`,
      },
      xAxis: { type: "value", name: toTitleCase(metricLabel(summaryBundle.primaryMetric)) },
      yAxis: { type: "value", name: toTitleCase(metricLabel(summaryBundle.secondaryMetric)) },
      series: [{
        type: "scatter",
        symbolSize: 12,
        data,
        itemStyle: { color: colorPrimary },
      }],
    },
  }, base.title);
}

function buildRelationshipBucketSpec(summaryBundle, title = "Relationship summary") {
  const grouped = summaryBundle.crossMetricRelationships?.grouped || [];
  return validateChartSpec({
    chart_type: "grouped_bar",
    title,
    subtitle: `How ${metricLabel(summaryBundle.secondaryMetric)} changed across lower and higher ${metricLabel(summaryBundle.primaryMetric)} days`,
    takeaway: summaryBundle.crossMetricRelationships?.statement || "Here is the grouped comparison.",
    option: {
      xAxis: { type: "category", data: grouped.map((item) => item.label) },
      yAxis: { type: "value", name: metricUnit(summaryBundle.secondaryMetric) },
      series: [{ type: "bar", name: toTitleCase(metricLabel(summaryBundle.secondaryMetric)), data: grouped.map((item) => item.value) }],
    },
    suggested_follow_up: ["Explain this relationship.", "Compare with the previous period."],
  }, title);
}

function buildSleepTimelineSpec(summaryBundle, title = "Sleep stages through the night") {
  const STAGE_COLORS = { Deep: "#3B82F6", Light: "#A78BFA", REM: "#06B6D4", Wake: "#FB923C" };
  const rawTimeline = Array.isArray(summaryBundle.sleepStageTimeline) ? summaryBundle.sleepStageTimeline.slice(0, 32) : [];
  const labels = rawTimeline.map((item) => item.clockLabel || item.label || "");
  const keep = labels.map((l) => {
    const s = String(l || "").trim();
    return s !== "0" && s !== "";
  });
  const timeline = rawTimeline.filter((_, i) => keep[i]);
  const filteredLabels = labels.filter((_, i) => keep[i]);
  const stageNames = ["Deep", "Light", "REM", "Wake"];
  const stageToKey = { Deep: "deep", Light: "light", REM: "rem", Wake: "wake" };
  const readStageMinutes = (item, stageKey) => {
    const stageMap = item?.stages || item?.stageMinutes || {};
    return Number(stageMap?.[stageKey] || 0);
  };
  return validateChartSpec({
    chart_type: "stacked_bar",
    title,
    subtitle: summaryBundle.timeLabel,
    takeaway: summaryBundle.sleepQuality?.takeaway || "This shows how your sleep stages changed across the night.",
    option: {
      color: stageNames.map((name) => STAGE_COLORS[name]),
      legend: { top: 4 },
      xAxis: { type: "category", data: filteredLabels },
      yAxis: { type: "value", name: "minutes" },
      series: stageNames.map((name) => ({
        type: "bar",
        stack: "sleep",
        name,
        data: timeline.map((item) => readStageMinutes(item, stageToKey[name])),
        itemStyle: { color: STAGE_COLORS[name] },
        label: { show: false },
      })),
    },
    suggested_follow_up: ["Compare sleep stages with my baseline.", "Explain what stands out."],
  }, title);
}

function buildSleepStageComparisonSpec(summaryBundle, title = "Sleep stages vs baseline") {
  const rows = Array.isArray(summaryBundle.sleepStageComparison) ? summaryBundle.sleepStageComparison : [];
  return validateChartSpec({
    chart_type: "grouped_bar",
    title,
    subtitle: "Current night compared with your longer-term stage averages",
    takeaway: summaryBundle.sleepQuality?.takeaway || "This helps show which stage was above or below your usual baseline.",
    option: {
      color: ["#5B6CFF", "#94A3B8"],
      xAxis: { type: "category", data: rows.map((row) => row.stage) },
      yAxis: { type: "value", name: "minutes" },
      series: [
        { type: "bar", name: "Last night", data: rows.map((row) => row.currentMinutes), itemStyle: { color: "#5B6CFF" } },
        { type: "bar", name: "Baseline", data: rows.map((row) => row.baselineMinutes), itemStyle: { color: "#94A3B8" } },
      ],
    },
    suggested_follow_up: ["Explain what this means.", "Show the sleep timeline."],
  }, title);
}

const SLEEP_STAGE_TREND_COLORS = { Deep: "#3B82F6", Light: "#A78BFA", REM: "#06B6D4", Wake: "#FB923C" };

function buildSleepStageTrendSpec(summaryBundle, base) {
  const stageTrend = summaryBundle.sleepStageTrendSeries || {};
  const labels = stageTrend.deep?.map((point) => point.label) || [];
  const stageKeys = [
    ["deep", "Deep"],
    ["light", "Light"],
    ["rem", "REM"],
    ["wake", "Wake"],
  ];
  const filtered = stageKeys.filter(([key]) => Array.isArray(stageTrend[key]) && stageTrend[key].length);
  const colors = filtered.map(([, label]) => SLEEP_STAGE_TREND_COLORS[label] || "#94A3B8");
  return validateChartSpec({
    ...base,
    chart_type: "multi_line",
    takeaway: summaryBundle.sleepQuality?.takeaway || base.takeaway,
    option: {
      color: colors,
      legend: { top: 8 },
      xAxis: { type: "category", data: labels },
      yAxis: { type: "value", name: "minutes" },
      series: filtered.map(([key, label], idx) => {
        const color = colors[idx];
        return {
          ...seriesToLine(`sleep_${key}`, stageTrend[key].map((point) => Number(point.value || 0))),
          name: label,
          lineStyle: { width: VISUAL_SYSTEM.chartDefaults.lineWidth, color },
          itemStyle: { color },
        };
      }),
    },
  }, base.title);
}

function getIntradayPresentationMeta(summaryBundle, metricKey = "") {
  const resolvedMetric = metricKey || summaryBundle.primaryMetric;
  return summaryBundle.intradayAvailabilityMap?.[resolvedMetric]
    || summaryBundle.intradayAvailabilityMap?.[intradayMetricForMetric(resolvedMetric)]
    || null;
}

function applyIntradayPresentationMeta(base, summaryBundle, metricKey = "") {
  const intradayMeta = getIntradayPresentationMeta(summaryBundle, metricKey);
  if (!intradayMeta) return base;
  return {
    ...base,
    subtitle: intradayMeta.is_synthetic
      ? [base.subtitle, "Estimated pattern"].filter(Boolean).join(" | ")
      : base.subtitle,
    is_synthetic: Boolean(intradayMeta.is_synthetic),
    data_quality_note: intradayMeta.data_quality_note || "",
    source: intradayMeta.source || null,
    intraday_status: intradayMeta.intraday_status || null,
    intraday_reason: intradayMeta.intraday_reason || "",
  };
}

function buildIntradayWindowSpec(summaryBundle, title = "Intraday pattern") {
  const buckets = summaryBundle.intradayWindowSummary?.buckets || [];
  const base = applyIntradayPresentationMeta({
    chart_type: "bar",
    title,
    subtitle: summaryBundle.timeLabel,
    takeaway: summaryBundle.intradayWindowSummary?.takeaway || "This shows which part of the day was most active.",
  }, summaryBundle, summaryBundle.primaryMetric);
  return validateChartSpec({
    ...base,
    option: {
      xAxis: { type: "category", data: buckets.map((row) => row.label) },
      yAxis: { type: "value" },
      series: [{ type: "bar", data: buckets.map((row) => row.value) }],
    },
    suggested_follow_up: ["Explain what stands out.", "Compare with my usual pattern."],
  }, title);
}

function buildMultiPeriodComparisonSpec(summaryBundle, base) {
  const periods = summaryBundle.previousPeriodComparison?.periods || [];
  if (periods.length < 3) return null;
  const labels = periods.map((p) => p.label);
  const values = periods.map((p) => Number(p.value) || 0);
  return validateChartSpec({
    ...base,
    chart_type: "bar",
    option: {
      xAxis: { type: "category", data: labels },
      yAxis: { type: "value", name: summaryBundle.unit },
      series: [{ type: "bar", data: values, label: { show: false } }],
    },
  }, base.title);
}

function buildComparisonSpec(summaryBundle, base) {
  const palette = metricToPalette(summaryBundle.primaryMetric);
  const colorPrevious = palette.secondary;
  const colorCurrent = palette.primary;
  return validateChartSpec({
    ...base,
    chart_type: "grouped_bar",
    option: {
      color: [colorPrevious, colorCurrent],
      xAxis: {
        type: "category",
        data: summaryBundle.previousPeriodComparison.current.map((point) => point.label),
      },
      yAxis: { type: "value", name: summaryBundle.unit },
      series: [
        { type: "bar", name: "Previous", data: summaryBundle.previousPeriodComparison.previous.map((point) => point.value), itemStyle: { color: colorPrevious } },
        { type: "bar", name: "Current", data: summaryBundle.previousPeriodComparison.current.map((point) => point.value), itemStyle: { color: colorCurrent } },
      ],
    },
  }, base.title);
}

function buildComparisonTrendSpec(summaryBundle, base, chartType = "line") {
  const palette = metricToPalette(summaryBundle.primaryMetric);
  const colorPrevious = palette.secondary;
  const colorCurrent = palette.primary;
  return validateChartSpec({
    ...base,
    chart_type: chartType === "area" ? "area" : "line",
    option: {
      color: [colorPrevious, colorCurrent],
      legend: { top: 8 },
      xAxis: {
        type: "category",
        data: summaryBundle.previousPeriodComparison.current.map((point) => point.label),
      },
      yAxis: { type: "value", name: summaryBundle.unit },
      series: [
        {
          ...seriesToLine(`${summaryBundle.primaryMetric}_previous`, summaryBundle.previousPeriodComparison.previous.map((point) => point.value)),
          name: "Previous",
          lineStyle: { width: VISUAL_SYSTEM.chartDefaults.lineWidth, color: colorPrevious },
          itemStyle: { color: colorPrevious },
          areaStyle: chartType === "area" ? { opacity: 0.1, color: colorPrevious } : undefined,
        },
        {
          ...seriesToLine(summaryBundle.primaryMetric, summaryBundle.previousPeriodComparison.current.map((point) => point.value)),
          name: "Current",
          lineStyle: { width: VISUAL_SYSTEM.chartDefaults.lineWidth, color: colorCurrent },
          itemStyle: { color: colorCurrent },
          areaStyle: chartType === "area" ? { opacity: 0.16, color: colorCurrent } : undefined,
        },
      ],
    },
  }, base.title);
}

function buildWeekdayHeatmapSpec(summaryBundle, base, primaryMetric, labels, primaryValues) {
  if (!labels?.length || !primaryValues?.length) return null;
  const yCategories = [toTitleCase(metricLabel(primaryMetric))];
  const data = primaryValues.map((value, i) => [i, 0, Number(value) || 0]);
  const nums = primaryValues.map((v) => Number(v) || 0).filter(Number.isFinite);
  const minVal = nums.length ? Math.min(...nums) : 0;
  const maxVal = nums.length ? Math.max(...nums) : 1;
  const rangeMax = maxVal > minVal ? maxVal : minVal + 1;
  return validateChartSpec({
    ...base,
    chart_type: "heatmap",
    option: {
      tooltip: { position: "top" },
      grid: { left: 56, right: 24, top: 24, bottom: 56, containLabel: true },
      xAxis: { type: "category", data: labels, splitArea: { show: false } },
      yAxis: { type: "category", data: yCategories, splitArea: { show: false } },
      visualMap: {
        min: minVal,
        max: rangeMax,
        calculable: false,
        orient: "horizontal",
        left: "center",
        bottom: 8,
        inRange: { color: ["#E0F2FE", "#0EA5E9", "#0369A1"] },
      },
      series: [{ type: "heatmap", data }],
    },
  }, base.title);
}

function buildRadarSpec(summaryBundle, base, metrics) {
  const metricKeys = (Array.isArray(metrics) ? metrics : []).slice(0, 6).filter(Boolean);
  if (metricKeys.length < 2) return null;
  const valuesByMetric = summaryBundle.normalizedSeries?.valuesByMetric || {};
  const indicators = metricKeys.map((key) => {
    const vals = valuesByMetric[key] || [];
    const maxVal = vals.length ? Math.max(...vals.map((v) => Number(v) || 0).filter(Number.isFinite)) : 100;
    const goal = getGoalForMetric(key, null);
    const max = Number.isFinite(Number(goal)) && Number(goal) > 0 ? Number(goal) : Math.max(maxVal || 1, 100);
    return { name: toTitleCase(metricLabel(key)), max };
  });
  const values = metricKeys.map((key) => {
    const vals = valuesByMetric[key] || [];
    const last = vals.length ? Number(vals[vals.length - 1]) : 0;
    const ind = indicators[metricKeys.indexOf(key)];
    const max = ind?.max || 100;
    return Number.isFinite(last) ? Math.min(max, Math.max(0, last)) : 0;
  });
  return validateChartSpec({
    ...base,
    chart_type: "radar",
    option: {
      radar: { indicator: indicators.map((i) => ({ name: i.name, max: i.max })) },
      series: [{ type: "radar", data: [{ value: values, name: summaryBundle.timeLabel || "Summary" }] }],
    },
  }, base.title);
}

function stripZeroLabelsFromSeries(normalizedSeries) {
  const labels = normalizedSeries?.labels || [];
  if (!labels.length) return normalizedSeries;
  const keep = labels.map((l) => l !== "0" && String(l).trim() !== "0");
  if (keep.every(Boolean)) return normalizedSeries;
  const filteredLabels = labels.filter((_, i) => keep[i]);
  const valuesByMetric = normalizedSeries?.valuesByMetric || {};
  const filteredValuesByMetric = Object.fromEntries(
    Object.entries(valuesByMetric).map(([k, arr]) => [k, (arr || []).filter((_, i) => keep[i])])
  );
  return {
    ...normalizedSeries,
    labels: filteredLabels,
    valuesByMetric: filteredValuesByMetric,
  };
}

function buildPrimaryChartSpec(plan, summaryBundle, presentation) {
  const focusMetrics = Array.isArray(presentation?.focus_metrics) && presentation.focus_metrics.length
    ? presentation.focus_metrics.filter((metricKey) => (summaryBundle.metricsShown || []).includes(metricKey))
    : [];
  const activeMetrics = focusMetrics.length ? focusMetrics : (summaryBundle.metricsShown || []);
  const primaryMetric = activeMetrics[0] || summaryBundle.primaryMetric;
  const secondaryMetric = activeMetrics[1] || summaryBundle.secondaryMetric;
  const palette = metricToPalette(primaryMetric);
  const normalizedSeries = stripZeroLabelsFromSeries(summaryBundle.normalizedSeries || {});
  summaryBundle = { ...summaryBundle, normalizedSeries };
  const labels = normalizedSeries.labels || [];
  const primaryValues = normalizedSeries.valuesByMetric?.[primaryMetric] || [];
  const preferred = presentation.visual_family || plan.visual_family || plan.preferred_chart || "bar";
  const goal = primaryMetric === summaryBundle.primaryMetric ? summaryBundle.goalProgress.goal : getGoalForMetric(primaryMetric, null);
  const title = presentation.chart_title;
  const subtitle = presentation.chart_subtitle;
  const takeaway = presentation.chart_takeaway;
  const base = {
    title,
    subtitle,
    takeaway,
    suggested_follow_up: presentation.suggested_drill_downs,
  };
  const chartBase = isIntradayMetric(primaryMetric)
    ? applyIntradayPresentationMeta(base, summaryBundle, primaryMetric)
    : base;

  const hasSleepScope = ["sleep_minutes", "sleep_efficiency", "wake_minutes"].includes(primaryMetric);
  const usesSleepStageBreakdown = primaryMetric === "sleep_minutes" && Array.isArray(summaryBundle.sleepStageBreakdown) && summaryBundle.sleepStageBreakdown.length;
  const usesSleepStageTimeline = primaryMetric === "sleep_minutes" && Array.isArray(summaryBundle.sleepStageTimeline) && summaryBundle.sleepStageTimeline.length;

  if (plan.question_type === "relationship_report" && secondaryMetric) {
    const relationshipSummary = { ...summaryBundle, primaryMetric, secondaryMetric };
    const grouped = summaryBundle.crossMetricRelationships?.grouped || [];
    const useBucketChart = grouped.length >= 2 && preferred !== "scatter";
    if (useBucketChart) {
      return buildRelationshipBucketSpec(relationshipSummary, chartBase.title || "Relationship");
    }
    return buildRelationshipScatterSpec({ summaryBundle: relationshipSummary, base: chartBase });
  }

  if (preferred === "radar" && activeMetrics.length >= 2) {
    const radarSpec = buildRadarSpec(summaryBundle, chartBase, activeMetrics.length ? activeMetrics : summaryBundle.metricsShown);
    if (radarSpec) return radarSpec;
  }

  if (preferred === "heatmap" && labels.length >= 1 && primaryValues.length >= 1) {
    const heatmapSpec = buildWeekdayHeatmapSpec(summaryBundle, chartBase, primaryMetric, labels, primaryValues);
    if (heatmapSpec) return heatmapSpec;
  }

  const singleValueGauge =
    preferred === "gauge" ||
    (primaryValues.length === 1 && !["grouped_bar", "scatter", "pie", "timeline", "multi_line", "composed_summary"].includes(preferred));
  if (singleValueGauge) {
    const currentValue =
      primaryValues.length >= 1 && Number.isFinite(Number(primaryValues[0]))
        ? Number(primaryValues[0])
        : (summaryBundle.metricStatsMap?.[primaryMetric]?.current ?? summaryBundle.currentPeriodStats?.current ?? 0);
    const weekAvg = summaryBundle.metricStatsMap?.[primaryMetric]?.avg ?? summaryBundle.currentPeriodStats?.avg;
    const numGoal = Number(goal);
    const max =
      Number.isFinite(numGoal) && numGoal > 0
        ? numGoal
        : primaryMetric === "sleep_efficiency" || primaryMetric === "wake_minutes"
          ? 100
          : Math.max(1, Math.ceil((currentValue || 0) * 1.5));
    const value = Math.max(0, Math.min(max, Number(currentValue) || 0));
    const weekAvgRatio = Number.isFinite(weekAvg) && weekAvg > 0 && max > 0
      ? Math.min(1, Math.max(0, Number(weekAvg) / max))
      : null;
    const axisLineStyle =
      weekAvgRatio != null && weekAvgRatio > 0 && weekAvgRatio < 1
        ? { width: 16, color: [[weekAvgRatio, "#94A3B8"], [1, "#E2E8F0"]] }
        : { width: 16 };
    return validateChartSpec(
      {
        ...chartBase,
        chart_type: "gauge",
        option: {
          series: [
            {
              type: "gauge",
              max,
              progress: { show: true, width: 16 },
              axisLine: { lineStyle: axisLineStyle },
              pointer: { show: false },
              axisTick: { show: false },
              splitLine: { show: false },
              axisLabel: { show: false },
              detail: { formatter: "{value}", fontSize: 26, fontWeight: 700 },
              data: [{ value: Math.round(value * 10) / 10, name: "Progress" }],
            },
          ],
        },
      },
      title,
    );
  }

  if (usesSleepStageTimeline && (preferred === "timeline" || plan.question_type === "chart_explanation")) {
    return buildSleepTimelineSpec(summaryBundle, title);
  }

  if (usesSleepStageBreakdown && preferred === "pie") {
    const PIE_STAGE_COLORS = { Deep: "#3B82F6", Light: "#A78BFA", REM: "#06B6D4", Wake: "#FB923C" };
    return validateChartSpec({
      ...chartBase,
      chart_type: "pie",
      takeaway: summaryBundle.sleepQuality?.takeaway || chartBase.takeaway,
      option: {
        color: summaryBundle.sleepStageBreakdown.map((slice) => PIE_STAGE_COLORS[slice.name] || "#94A3B8"),
        legend: { bottom: 14, left: "center", orient: "horizontal", textStyle: { fontSize: 14 } },
        series: [{
          type: "pie",
          center: ["50%", "42%"],
          radius: ["32%", "58%"],
          data: summaryBundle.sleepStageBreakdown.map((slice) => ({
            name: slice.name,
            value: Number(slice.value) || 0,
            itemStyle: { color: PIE_STAGE_COLORS[slice.name] || "#94A3B8" },
          })),
          label: { show: true, fontSize: 14, formatter: "{b}: {d}%" },
        }],
      },
    }, title);
  }

  if (preferred === "scatter" && secondaryMetric) {
    const relationshipSummary = { ...summaryBundle, primaryMetric, secondaryMetric };
    return buildRelationshipScatterSpec({ summaryBundle: relationshipSummary, base: chartBase });
  }

  if (preferred === "stacked_bar" && secondaryMetric) {
    const palPrimary = metricToPalette(primaryMetric);
    const palSecondary = metricToPalette(secondaryMetric);
    const colorPrimary = palPrimary.primary;
    const colorSecondary = palSecondary.primary === colorPrimary ? palPrimary.secondary : palSecondary.primary;
    return validateChartSpec({
      ...chartBase,
      chart_type: "stacked_bar",
      option: {
        color: [colorPrimary, colorSecondary],
        xAxis: { type: "category", data: labels },
        yAxis: { type: "value" },
        series: [
          { type: "bar", name: toTitleCase(metricLabel(primaryMetric)), stack: "total", data: primaryValues, itemStyle: { color: colorPrimary } },
          { type: "bar", name: toTitleCase(metricLabel(secondaryMetric)), stack: "total", data: summaryBundle.normalizedSeries.valuesByMetric?.[secondaryMetric] || [], itemStyle: { color: colorSecondary } },
        ],
      },
    }, title);
  }

  if (preferred === "composed_summary" || ((activeMetrics || []).length > 1 && ["overview_report", "anomaly_explanation", "deep_dive"].includes(plan.question_type))) {
    const overviewSummary = { ...summaryBundle, primaryMetric, metricsShown: activeMetrics.length ? activeMetrics : summaryBundle.metricsShown };
    return buildOverviewComposedSpec({ plan, summaryBundle: overviewSummary, presentation, labels, primaryValues, base: chartBase });
  }

  if (preferred === "multi_line" || (activeMetrics || []).length > 1) {
    const metricKeys = (activeMetrics.length ? activeMetrics : Object.keys(summaryBundle.normalizedSeries.valuesByMetric || {})).slice(0, 4);
    const fallbackPalette = metricToPalette("fallback");
    const seriesColors = fallbackPalette.series && fallbackPalette.series.length
      ? fallbackPalette.series
      : [fallbackPalette.primary, fallbackPalette.secondary, fallbackPalette.accent, "#8B5CF6"];
    const colors = metricKeys.map((_, idx) => seriesColors[idx % seriesColors.length]);
    return validateChartSpec({
      ...chartBase,
      chart_type: "multi_line",
      option: {
        color: colors,
        xAxis: { type: "category", data: labels },
        yAxis: { type: "value" },
        series: metricKeys.map((metricKey, idx) => {
          const color = colors[idx];
          return {
            ...seriesToLine(metricKey, summaryBundle.normalizedSeries.valuesByMetric?.[metricKey] || []),
            lineStyle: { width: VISUAL_SYSTEM.chartDefaults.lineWidth, color },
            itemStyle: { color },
          };
        }),
      },
    }, title);
  }

  if ((preferred === "area" || preferred === "timeline") && summaryBundle.intradayWindowSummary?.buckets?.length) {
    if (String(primaryMetric).endsWith("_intraday")) {
      return validateChartSpec({
        ...chartBase,
        chart_type: preferred === "timeline" ? "timeline" : "area",
        takeaway: summaryBundle.intradayInsights?.takeaway || chartBase.takeaway,
        option: {
          xAxis: { type: "category", data: labels },
          yAxis: { type: "value", name: metricUnit(primaryMetric) || summaryBundle.unit },
          series: [{
            ...seriesToLine(primaryMetric, primaryValues),
            areaStyle: preferred === "area" || preferred === "timeline" ? { opacity: 0.16, color: palette.secondary } : undefined,
          }],
        },
      }, title);
    }
    return buildIntradayWindowSpec(summaryBundle, title);
  }

  if ((preferred === "line" || preferred === "area") && plan.question_type === "comparison_report" && summaryBundle.previousPeriodComparison?.current?.length) {
    return buildComparisonTrendSpec(summaryBundle, chartBase, preferred);
  }

  if (preferred === "area" || preferred === "timeline" || preferred === "line") {
    return validateChartSpec({
      ...chartBase,
      chart_type: preferred === "timeline" ? "timeline" : preferred === "line" ? "line" : "area",
      option: {
        xAxis: { type: "category", data: labels },
        yAxis: { type: "value", name: metricUnit(primaryMetric) || summaryBundle.unit },
        series: [{
          ...seriesToLine(primaryMetric, primaryValues),
          areaStyle: preferred === "area" ? { opacity: 0.16, color: palette.secondary } : undefined,
        }],
      },
    }, title);
  }

  if (plan.question_type === "comparison_report" && summaryBundle.previousPeriodComparison?.periods?.length >= 3) {
    const multiSpec = buildMultiPeriodComparisonSpec({ ...summaryBundle, primaryMetric }, chartBase);
    if (multiSpec) return multiSpec;
  }

  if (preferred === "grouped_bar" && summaryBundle.previousPeriodComparison?.current?.length) {
    return buildComparisonSpec({ ...summaryBundle, primaryMetric }, chartBase);
  }

  if (preferred === "grouped_bar" && labels.length >= 2 && primaryValues.length >= 2) {
    const points = labels.map((label, i) => ({ label, value: primaryValues[i], date: null, fullLabel: label }));
    const synthetic = buildSyntheticPeriodComparison(points, 7);
    if (synthetic?.current?.length && synthetic?.previous?.length) {
      return buildComparisonSpec({
        ...summaryBundle,
        primaryMetric,
        previousPeriodComparison: synthetic,
        unit: summaryBundle.unit || metricUnit(primaryMetric),
      }, chartBase);
    }
  }

  if (usesSleepStageBreakdown) {
    if (summaryBundle.sleepStageBreakdown?.length) {
      const PIE_STAGE_COLORS = { Deep: "#3B82F6", Light: "#A78BFA", REM: "#06B6D4", Wake: "#FB923C" };
    return validateChartSpec({
      ...chartBase,
      chart_type: "pie",
      takeaway: summaryBundle.sleepQuality?.takeaway || chartBase.takeaway,
      option: {
          color: summaryBundle.sleepStageBreakdown.map((slice) => PIE_STAGE_COLORS[slice.name] || "#94A3B8"),
          legend: { bottom: 14, left: "center", orient: "horizontal", textStyle: { fontSize: 14 } },
          series: [{
            type: "pie",
            center: ["50%", "42%"],
            radius: ["32%", "58%"],
            data: summaryBundle.sleepStageBreakdown.map((slice) => ({
              name: slice.name,
              value: Number(slice.value) || 0,
              itemStyle: { color: PIE_STAGE_COLORS[slice.name] || "#94A3B8" },
            })),
            label: { show: true, fontSize: 14, formatter: "{b}: {d}%" },
          }],
        },
      }, title);
    }
  }

  return validateChartSpec({
    ...chartBase,
    chart_type: "bar",
    highlight: summaryBundle.chartContext.highlight,
    option: {
      color: [palette.primary],
      xAxis: { type: "category", data: labels },
      yAxis: { type: "value", name: metricUnit(primaryMetric) || summaryBundle.unit },
      series: [{ type: "bar", data: primaryValues }],
    },
  }, title);
}

function buildMetricScopedSummary(summaryBundle, metrics = []) {
  const scopedMetrics = (Array.isArray(metrics) ? metrics : []).filter(Boolean);
  const primaryMetric = scopedMetrics[0] || summaryBundle.primaryMetric;
  const secondaryMetric = scopedMetrics[1] || null;
  const relationshipKey = secondaryMetric ? `${primaryMetric}|${secondaryMetric}` : null;
  const baseMetric = baseMetricForIntraday(primaryMetric);
  const scopedIntradayMetric = intradayMetricForMetric(baseMetric);
  const summaryPrimaryBaseMetric = baseMetricForIntraday(summaryBundle.primaryMetric);
  const inheritsPrimaryIntraday = primaryMetric === summaryBundle.primaryMetric || baseMetric === summaryPrimaryBaseMetric;
  return {
    ...summaryBundle,
    primaryMetric,
    secondaryMetric,
    metricsShown: scopedMetrics.length ? scopedMetrics : summaryBundle.metricsShown,
    currentPeriodStats: summaryBundle.metricStatsMap?.[primaryMetric]
      || summaryBundle.metricStatsMap?.[baseMetric]
      || summaryBundle.currentPeriodStats,
    previousPeriodComparison: summaryBundle.metricComparisonMap?.[primaryMetric]
      || summaryBundle.metricComparisonMap?.[baseMetric]
      || summaryBundle.previousPeriodComparison,
    anomalies: summaryBundle.metricAnomaliesMap?.[primaryMetric]
      || summaryBundle.metricAnomaliesMap?.[baseMetric]
      || summaryBundle.anomalies,
    goalProgress: {
      goal: getGoalForMetric(baseMetric, null),
      progressPct: summaryBundle.metricStatsMap?.[primaryMetric]?.goalProgressPct
        ?? summaryBundle.metricStatsMap?.[baseMetric]?.goalProgressPct
        ?? summaryBundle.goalProgress?.progressPct
        ?? null,
    },
    crossMetricRelationships: relationshipKey
      ? summaryBundle.relationshipMap?.[relationshipKey] || summaryBundle.crossMetricRelationships
      : summaryBundle.crossMetricRelationships,
    groupedEffectSummaries: relationshipKey
      ? summaryBundle.relationshipMap?.[relationshipKey]?.groupedEffectSummary || null
      : summaryBundle.groupedEffectSummaries,
    intradayWindowSummary: summaryBundle.intradaySummaryMap?.[primaryMetric]
      || summaryBundle.intradaySummaryMap?.[scopedIntradayMetric]
      || (inheritsPrimaryIntraday ? summaryBundle.intradayWindowSummary : null),
    intradayInsights: summaryBundle.intradayInsightsMap?.[primaryMetric]
      || summaryBundle.intradayInsightsMap?.[scopedIntradayMetric]
      || (inheritsPrimaryIntraday ? summaryBundle.intradayInsights : null)
      || null,
    intradayAvailabilityMap: summaryBundle.intradayAvailabilityMap || {},
    sleepSeriesBundle: scopedMetrics.some((m) => ["sleep_minutes", "sleep_efficiency", "wake_minutes"].includes(m)) ? summaryBundle.sleepSeriesBundle : null,
    sleepStageBreakdown: scopedMetrics.some((m) => ["sleep_minutes", "sleep_efficiency", "wake_minutes"].includes(m)) ? summaryBundle.sleepStageBreakdown : null,
    sleepStageComparison: scopedMetrics.some((m) => ["sleep_minutes", "sleep_efficiency", "wake_minutes"].includes(m)) ? summaryBundle.sleepStageComparison : null,
    sleepStageTrendSeries: scopedMetrics.some((m) => ["sleep_minutes", "sleep_efficiency", "wake_minutes"].includes(m)) ? summaryBundle.sleepStageTrendSeries : null,
    sleepStageTimeline: scopedMetrics.some((m) => ["sleep_minutes", "sleep_efficiency", "wake_minutes"].includes(m)) ? summaryBundle.sleepStageTimeline : null,
    sleepTimingSummary: scopedMetrics.some((m) => ["sleep_minutes", "sleep_efficiency", "wake_minutes"].includes(m)) ? summaryBundle.sleepTimingSummary : null,
    sleepQuality: scopedMetrics.some((m) => ["sleep_minutes", "sleep_efficiency", "wake_minutes"].includes(m)) ? summaryBundle.sleepQuality : null,
    unit: metricUnit(primaryMetric) || metricUnit(baseMetric),
  };
}

function buildChartPresentationFromPanel(reportPlan, panel, nextViews, spokenAnswer) {
  return {
    chart_title: panel.title,
    chart_subtitle: panel.subtitle,
    chart_takeaway: reportPlan.takeaway,
    visual_family: panel.visual_family,
    suggested_drill_downs: sanitizeListText(nextViews.map((view) => view.label), 3, 80),
    primary_answer: reportPlan.takeaway,
    voice_answer: spokenAnswer,
    focus_metrics: panel.metrics,
  };
}

function buildPanelChartSpec(panel, reportPlan, summaryBundle, plan, spokenAnswer, panelIndex = 0, panelCount = 1) {
  const scopedSummary = buildMetricScopedSummary(summaryBundle, panel.metrics);
  const scopedPlan = {
    ...plan,
    question_type: panel.goal,
    preferred_chart: panel.visual_family,
  };
  const scopedPresentation = buildChartPresentationFromPanel(reportPlan, panel, reportPlan.next_views || [], spokenAnswer);
  const chartSpec = buildPrimaryChartSpec(scopedPlan, scopedSummary, scopedPresentation);
  return applyPanelContrastTheme(chartSpec, panel, panelIndex, panelCount);
}

function validateReportPlan(reportPlan, summaryBundle, plan) {
  const availableMetrics = new Set(Object.keys(summaryBundle.metricStatsMap || {}));
  const candidatePanels = Array.isArray(reportPlan?.panels) ? reportPlan.panels : [];
  const normalizedPanels = candidatePanels
    .map((panel, index) => ({
      ...panel,
      panel_id: sanitizePlainText(panel?.panel_id, 64, `panel_${index + 1}`).replace(/[^a-z0-9_]+/gi, "_").toLowerCase(),
      title: sanitizePlainText(panel?.title, 80, "Health panel"),
      subtitle: sanitizePlainText(panel?.subtitle, 120, summaryBundle.timeLabel),
      emphasis: panel?.emphasis === "hero" ? "hero" : "standard",
      metrics: (Array.isArray(panel.metrics) ? panel.metrics : [])
        .map(normalizeMetric)
        .filter((metric) => metric && availableMetrics.has(metric))
        .slice(0, 4),
      visual_family: VISUAL_SYSTEM.allowed.chartTypes.includes(panel.visual_family) ? panel.visual_family : inferVisualForGoal(panel.goal, panel.metrics, plan),
    }))
    .filter((panel) => panel.metrics.length && VISUAL_SYSTEM.allowed.reportGoals.includes(panel.goal))
    .slice(0, 4);
  const fallback = buildDefaultReportPlan("", plan, summaryBundle);
  const sourcePanels = normalizedPanels.length ? normalizedPanels : fallback.panels;
  const usedVisuals = new Set();
  const chosenPanels = prioritizeTimelinePanelForThreePanelView(sourcePanels.map((panel, index) => {
    let visualFamily = panel.visual_family;
    if (usedVisuals.has(visualFamily) || sourcePanels.length > 1) {
      visualFamily = chooseVisualFamily(panel.goal, panel.metrics, plan, summaryBundle, usedVisuals);
    }
    usedVisuals.add(visualFamily);
    return {
      ...panel,
      visual_family: visualFamily,
      emphasis: panel.emphasis || (sourcePanels.length === 3 && index === 0 ? "hero" : "standard"),
    };
  }));
  const response_mode = chosenPanels.length > 1 ? "multi_panel_report" : "single_view";
  const nextViews = Array.isArray(reportPlan?.next_views)
    ? reportPlan.next_views
        .map((view) => ({
          ...view,
          metrics: (Array.isArray(view.metrics) ? view.metrics : [])
            .map(normalizeMetric)
            .filter((metric) => metric && availableMetrics.has(metric))
            .slice(0, 4),
        }))
        .filter((view) => view.metrics.length)
        .slice(0, 4)
    : fallback.next_views;
  return {
    ...reportPlan,
    response_mode,
    layout: pickLayoutForPanelCount(response_mode, chosenPanels.length, reportPlan?.layout),
    panels: chosenPanels,
    next_views: nextViews.length ? nextViews : fallback.next_views,
  };
}

function synthesizeStagesFromPanels(panels, spokenAnswer, nextViews, activePanelIndex = 0) {
  return (Array.isArray(panels) ? panels : []).map((panel, index) => ({
    id: panel.panel_id,
    cue: panel.title,
    speech: index === activePanelIndex ? spokenAnswer : panel.chart_spec?.takeaway || panel.title,
    voice_answer: index === activePanelIndex ? spokenAnswer : panel.chart_spec?.takeaway || panel.title,
    suggested_follow_up: sanitizeListText(nextViews.map((view) => view.label), 3, 80),
    chart_spec: panel.chart_spec,
  }));
}

function buildPayload({
  requestId = null,
  question,
  plan,
  fetched,
  summaryBundle,
  presentation,
  voiceAnswerOverride = "",
  voiceAnswerSource = "fallback",
  answerReady = voiceAnswerSource === "gpt",
  activePanelId = null,
  debug = null,
}) {
  qnaLog("payload", "buildPayload start", { question_type: plan.question_type, response_mode: presentation?.response_mode });
  const reportPlan = validateReportPlan(presentation, summaryBundle, plan);
  const spokenAnswer = compressAlexaSpeech(
    voiceAnswerOverride || reportPlan.spoken_answer,
    buildMicroAnswer({ questionType: plan.question_type, summaryBundle })
  );
  const builtPanels = reportPlan.panels.map((panel, index, arr) => ({
    ...panel,
    palette_key: summaryBundle.primaryMetric,
    chart_spec: buildPanelChartSpec(panel, reportPlan, summaryBundle, plan, spokenAnswer, index, arr.length),
  }));
  const activePanelIndex = Math.max(0, builtPanels.findIndex((panel) => panel.panel_id === activePanelId));
  const primaryPanel = builtPanels[activePanelIndex] || builtPanels[0];
  const suggestedDrillDowns = sanitizeListText(
    (reportPlan.next_views || []).map((view) => view.label),
    3,
    80
  );
  const stages = synthesizeStagesFromPanels(builtPanels, spokenAnswer, reportPlan.next_views || [], activePanelIndex);
  const chartContext = {
    requestId,
    originalQuestion: question,
    summaryBundle,
    chartTitle: primaryPanel?.title || reportPlan.report_title,
    chartType: primaryPanel?.chart_spec?.chart_type || "",
    metricsShown: summaryBundle.metricsShown,
    timeWindow: summaryBundle.timeWindow,
    intradayAvailabilityMap: summaryBundle.intradayAvailabilityMap || {},
    intraday_status: primaryPanel?.chart_spec?.intraday_status || summaryBundle.chartContext?.intraday_status || null,
    intraday_reason: primaryPanel?.chart_spec?.intraday_reason || summaryBundle.chartContext?.intraday_reason || "",
    is_synthetic: Boolean(primaryPanel?.chart_spec?.is_synthetic || summaryBundle.chartContext?.is_synthetic),
    data_quality_note: primaryPanel?.chart_spec?.data_quality_note || summaryBundle.chartContext?.data_quality_note || "",
    source: primaryPanel?.chart_spec?.source || summaryBundle.chartContext?.source || null,
    suggestedDrillDowns,
    followupMode: reportPlan.followup_mode,
    panels: builtPanels.map((panel, index) => ({
      panel_id: panel.panel_id,
      title: panel.title,
      goal: panel.goal,
      metrics: panel.metrics,
      visual_family: panel.visual_family,
      emphasis: panel.emphasis || "standard",
      index,
    })),
    nextViews: reportPlan.next_views || [],
  };

  return setPayloadVoiceState({
    status: "ready",
    requestId,
    question,
    question_type: plan.question_type,
    metrics_needed: plan.metrics_needed,
    time_scope: plan.time_scope,
    comparison_mode: plan.comparison_mode,
    response_mode: reportPlan.response_mode,
    layout: reportPlan.layout,
    spoken_answer: spokenAnswer,
    report_title: reportPlan.report_title,
    takeaway: reportPlan.takeaway,
    panels: builtPanels,
    next_views: reportPlan.next_views || [],
    suggested_followup_prompt: reportPlan.suggested_followup_prompt,
    voice_answer: spokenAnswer,
    primary_answer: reportPlan.takeaway,
    primary_visual: primaryPanel?.chart_spec || null,
    chart_spec: primaryPanel?.chart_spec || null,
    summary: {
      shortSpeech: spokenAnswer,
      shortText: reportPlan.takeaway,
    },
    summaryBundle,
    chartContext,
    metricsShown: summaryBundle.metricsShown,
    timeWindow: summaryBundle.timeWindow,
    suggestedDrillDowns,
    suggested_follow_up: suggestedDrillDowns,
    followup_mode: reportPlan.followup_mode,
    continuation_prompt: reportPlan.suggested_followup_prompt,
    stages,
    stageCount: stages.length,
    activeStageIndex: activePanelIndex,
    activePanelId: primaryPanel?.panel_id || null,
  }, spokenAnswer, voiceAnswerSource, answerReady, debug);
}

function buildStaticFallbackPayload({
  requestId = null,
  question,
  plan,
  title,
  spokenAnswer,
  takeaway,
  suggestedLabels = [],
  metricsShown = [],
  timeWindow = null,
  debug = null,
}) {
  const chartSpec = buildFallbackChartSpec(title, takeaway || spokenAnswer);
  const next_views = sanitizeListText(suggestedLabels, 4, 40).map((label, index) => buildNextView(`fallback_${index + 1}`, label, "deep_dive", metricsShown.length ? [metricsShown[0]] : ["steps"]));
  const panels = [{
    panel_id: "primary",
    title: chartSpec.title,
    subtitle: chartSpec.subtitle || "",
    goal: "single_metric_status",
    metrics: metricsShown.length ? metricsShown.slice(0, 4) : ["steps"],
    visual_family: chartSpec.chart_type,
    chart_spec: chartSpec,
  }];
  const stages = synthesizeStagesFromPanels(panels, spokenAnswer, next_views, 0);
  return setPayloadVoiceState({
    status: "ready",
    requestId,
    question,
    question_type: plan?.question_type || "single_metric_status",
    metrics_needed: metricsShown,
    time_scope: plan?.time_scope || "last_7_days",
    comparison_mode: plan?.comparison_mode || "none",
    response_mode: "single_view",
    layout: "single_focus",
    spoken_answer: spokenAnswer,
    report_title: chartSpec.title,
    takeaway: takeaway || spokenAnswer,
    panels,
    next_views,
    suggested_followup_prompt: next_views[0] ? `Say "${next_views[0].label.toLowerCase()}" for more.` : "",
    voice_answer: spokenAnswer,
    primary_answer: takeaway || spokenAnswer,
    primary_visual: chartSpec,
    chart_spec: chartSpec,
    summary: {
      shortSpeech: spokenAnswer,
      shortText: takeaway || spokenAnswer,
    },
    summaryBundle: null,
    chartContext: {
      requestId,
      originalQuestion: question,
      summaryBundle: null,
      chartTitle: chartSpec.title,
      chartType: chartSpec.chart_type,
      metricsShown,
      timeWindow,
      suggestedDrillDowns: sanitizeListText(suggestedLabels, 3, 80),
      panels: [{ panel_id: "primary", title: chartSpec.title, goal: "single_metric_status", metrics: metricsShown, index: 0 }],
      nextViews: next_views,
    },
    metricsShown,
    timeWindow,
    suggestedDrillDowns: sanitizeListText(suggestedLabels, 3, 80),
    suggested_follow_up: sanitizeListText(suggestedLabels, 3, 80),
    followup_mode: "suggested_drill_down",
    continuation_prompt: "",
    stages,
    stageCount: stages.length,
    activeStageIndex: 0,
    activePanelId: "primary",
  }, spokenAnswer, "fallback", true, debug);
}

function buildBridgeSpeech(plan) {
  const primaryMetric = plan?.metrics_needed?.[0] || "steps";
  const timeLabel = VISUAL_SYSTEM.timeScopeConfig?.[plan?.time_scope || "last_7_days"]?.label || "this period";
  return compressAlexaSpeech(`I am checking your ${metricLabel(primaryMetric)} for ${timeLabel} now.`);
}

async function buildVisualPayload({ requestId = null, question, plan, fetched, summaryBundle, userContext, allowPresenterLLM = true, debug = null }) {
  qnaLog("visual", "buildVisualPayload start", { allowPresenterLLM });
  try {
    const presentation = allowPresenterLLM
      ? await maybeBuildPresentation(question, plan, summaryBundle, userContext, PRESENT_CONFIG.timeoutMs, debug)
      : buildDefaultReportPlan(question, plan, summaryBundle);
    const voiceAnswerSource = allowPresenterLLM && !didTraceUseFallback(debug, "presenter")
      ? "gpt"
      : "fallback";
    const payload = buildPayload({
      requestId,
      question,
      plan,
      fetched,
      summaryBundle,
      presentation,
      voiceAnswerSource,
      answerReady: true,
      debug,
    });
    qnaLog("visual", "buildVisualPayload done", { stageCount: payload?.stageCount ?? 0 });
    return payload;
  } catch (err) {
    qnaError("visual", "buildVisualPayload failed", err);
    throw err;
  }
}

async function answerQuestion({
  requestId = null,
  username,
  question,
  voiceDeadlineMs = DEFAULT_VOICE_DEADLINE_MS,
  userContext = null,
  allowFetchPlannerLLM = true,
  allowPresenterLLM = true,
  enableVisualContinuation = false,
  fetchPlanTimeoutMs = FETCH_PLANNER_CONFIG.timeoutMs,
  fetchTimeoutMs = null,
}) {
  const q = sanitizePlainText(question, 280, "");
  const u = sanitizePlainText(username, 60, "amy").toLowerCase();
  const ctx = userContext || (await getUserContext(u)) || null;
  const debug = createDebugTrace();

  qnaLog("planner", "starting answerQuestion", {
    username: u,
    question: q,
    requestId,
    allowFetchPlannerLLM,
  });

  const plan = allowFetchPlannerLLM
    ? (await maybeRefineFetchPlan(q, null, fetchPlanTimeoutMs, debug)) ?? inferHeuristicFetchPlan(q)
    : inferHeuristicFetchPlan(q);

  qnaLog("planner", "plan finalized", {
    question_type: plan.question_type,
    metrics_needed: plan.metrics_needed,
    time_scope: plan.time_scope,
    comparison_mode: plan.comparison_mode,
  });

  if (plan.question_type === "reminder") {
    qnaLog("pipeline", "reminder branch — returning early");
    const payload = buildStaticFallbackPayload({
      requestId,
      question: q,
      plan,
        title: "Reminder help",
      spokenAnswer: "The reminder flow handles medication schedules. Ask me here about sleep, activity, heart trends, or comparisons.",
      takeaway: "The reminder flow handles medication schedules.",
      suggestedLabels: ["Sleep this week"],
      metricsShown: [],
      timeWindow: null,
      debug,
    });
    return {
      status: "complete",
      voiceAnswer: payload.voice_answer,
      payload,
      planner: plan,
      rawData: null,
      userContext: ctx,
      visualContinuationPromise: null,
    };
  }

  const fetched = await fetchRequestedData({ username: u, plan, fetchTimeoutMs });
  qnaLog("fetch", "fetch complete", {
    primaryMetric: fetched.primaryMetric,
    primaryCount: fetched.primaryCurrent?.length ?? 0,
    secondaryMetric: fetched.secondaryMetric ?? null,
    secondaryCount: fetched.secondaryCurrent?.length ?? 0,
  });

  if (!fetched.primaryCurrent?.length || fetched.primaryCurrent.every((point) => Number(point.value) === 0)) {
    qnaLog("pipeline", "no-data branch — returning early", { primaryMetric: fetched.primaryMetric });
    const noDataVoice = `I do not have enough ${metricLabel(fetched.primaryMetric)} data for ${fetched.primaryWindow.timeframeLabel} yet.`;
    const payload = buildStaticFallbackPayload({
      requestId,
      question: q,
      plan,
      title: `No ${metricLabel(fetched.primaryMetric)} data`,
      spokenAnswer: noDataVoice,
      takeaway: noDataVoice,
      suggestedLabels: ["Try again after syncing your Fitbit."],
      metricsShown: plan.metrics_needed,
      timeWindow: fetched.primaryWindow,
      debug,
    });
    return {
      status: "complete",
      voiceAnswer: noDataVoice,
      payload,
      planner: plan,
      rawData: fetched,
      userContext: ctx,
      visualContinuationPromise: null,
    };
  }

  const summaryBundle = buildSummaryBundle({ plan, fetched, userContext: ctx });
  qnaLog("summary", "summary bundle built", {
    primaryMetric: summaryBundle.primaryMetric,
    secondaryMetric: summaryBundle.secondaryMetric ?? null,
    hasRelationship: !!summaryBundle.crossMetricRelationships,
    primaryAvg: summaryBundle.currentPeriodStats?.avg,
    primaryCount: summaryBundle.rawSeries?.[summaryBundle.primaryMetric]?.length ?? 0,
  });

  const microAnswer = buildMicroAnswer({ questionType: plan.question_type, summaryBundle });
  let presentation = allowPresenterLLM
    ? await maybeBuildPresentation(q, plan, summaryBundle, ctx, PRESENT_CONFIG.timeoutMs, debug)
    : null;
  if (!presentation) presentation = buildDefaultReportPlan(q, plan, summaryBundle);
  const voiceAnswerSource = allowPresenterLLM && !didTraceUseFallback(debug, "presenter")
    ? "gpt"
    : "fallback";
  const finalPayload = buildPayload({
    requestId,
    question: q,
    plan,
    fetched,
    summaryBundle,
    presentation,
    voiceAnswerOverride: "",
    voiceAnswerSource,
    answerReady: true,
    debug,
  });

  qnaLog("pipeline", "answerQuestion returning", {
    status: "complete",
    voiceAnswerLength: finalPayload.voice_answer?.length ?? microAnswer.length ?? 0,
    });

    return {
      status: "complete",
    answerReady: true,
    voiceAnswerSource,
    voiceAnswer: finalPayload.voice_answer || microAnswer,
    payload: finalPayload,
      planner: plan,
      rawData: fetched,
      userContext: ctx,
    visualContinuationPromise: null,
    speechReadyPromise: null,
  };
}

async function buildRichQnaPayload({
  requestId = null,
  username,
  question,
  userContext = null,
  allowFetchPlannerLLM = true,
  allowPresenterLLM = true,
  fetchPlanTimeoutMs = FETCH_PLANNER_CONFIG.timeoutMs,
  fetchTimeoutMs = null,
}) {
  const q = sanitizePlainText(question, 280, "");
  const u = sanitizePlainText(username, 60, "amy").toLowerCase();
  const ctx = userContext || (await getUserContext(u)) || null;
  const debug = createDebugTrace();
  const plan = allowFetchPlannerLLM
    ? (await maybeRefineFetchPlan(q, null, fetchPlanTimeoutMs, debug)) ?? inferHeuristicFetchPlan(q)
    : inferHeuristicFetchPlan(q);
  const fetched = await fetchRequestedData({ username: u, plan, fetchTimeoutMs });
  if (!fetched.primaryCurrent?.length || fetched.primaryCurrent.every((point) => Number(point.value) === 0)) {
    const noDataVoice = `I do not have enough ${metricLabel(fetched.primaryMetric)} data for ${fetched.primaryWindow.timeframeLabel} yet.`;
    const payload = buildStaticFallbackPayload({
      requestId,
      question: q,
      plan,
      title: `No ${metricLabel(fetched.primaryMetric)} data`,
      spokenAnswer: noDataVoice,
      takeaway: noDataVoice,
      suggestedLabels: ["Try again after syncing your Fitbit."],
      metricsShown: plan.metrics_needed,
      timeWindow: fetched.primaryWindow,
      debug,
    });
    return { payload, planner: plan, rawData: fetched, userContext: ctx, bridgeSpeech: buildBridgeSpeech(plan) };
  }
  const summaryBundle = buildSummaryBundle({ plan, fetched, userContext: ctx });
  const presentation = allowPresenterLLM
    ? await maybeBuildPresentation(q, plan, summaryBundle, ctx, PRESENT_CONFIG.timeoutMs, debug)
    : buildDefaultReportPlan(q, plan, summaryBundle);
  const voiceAnswerSource = allowPresenterLLM && !didTraceUseFallback(debug, "presenter")
    ? "gpt"
    : "fallback";
  const payload = buildPayload({
    requestId,
    question: q,
    plan,
    fetched,
    summaryBundle,
    presentation,
    voiceAnswerSource,
    answerReady: true,
    debug,
  });
  qnaLog("present", "built rich payload", {
    requestId,
    chartType: payload.primary_visual?.chart_type,
    suggestedDrillDowns: payload.suggestedDrillDowns,
  });
  return { payload, planner: plan, rawData: fetched, userContext: ctx, bridgeSpeech: buildBridgeSpeech(plan) };
}

async function answerFollowupFromPayload({ payload, question }) {
  const summaryBundle = payload?.summaryBundle || payload?.chartContext?.summaryBundle || null;
  const chartContext = payload?.chartContext || {};
  const panels = Array.isArray(payload?.panels) ? payload.panels : [];
  const nextViews = Array.isArray(payload?.next_views) ? payload.next_views : [];
  const debug = payload?.debug?.gpt_trace ? { gpt_trace: { ...payload.debug.gpt_trace } } : createDebugTrace();
  const fallbackAnswer = summaryBundle?.storyCandidates?.[0]
    || payload?.primary_visual?.takeaway
    || payload?.takeaway
    || payload?.summary?.shortText
    || "Here is what stands out.";
  const q = String(question || "").toLowerCase();
  const activeIndex = Number(payload?.activeStageIndex || 0);

  const normalizeText = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const normalizedQuestion = normalizeText(question);
  const isContinueAfterTimeout = /\b(continue|go on|yes)\b/.test(q) && !/\b(tell me more|more detail|go deeper|deeper|show more)\b/.test(q);
  const isTellMeMore = /\b(tell me more|more detail|go deeper|deeper|show more)\b/.test(q);
  const shouldAdvance = /\b(next)\b/.test(q);
  const wantsOverview = /\b(report|overview|summary|main chart|go back|start over)\b/.test(q);
  const wantsExplanation = /\b(explain|why do you say that|why|what does this mean|what stands out|interpret)\b/.test(q);

  const activePanelId = payload?.activePanelId || panels[activeIndex]?.panel_id || null;
  const activeViewIndex = nextViews.findIndex((view) => view.id === activePanelId);
  const activePanel = panels.find((panel) => panel.panel_id === activePanelId) || panels[activeIndex] || panels[0] || null;
  const followupSuggestions = sanitizeListText((payload?.next_views || []).map((view) => view.label), 2, 80);

  const buildFollowupResponse = ({
    nextPayload = payload,
    answer = "",
    answerReady = false,
    voiceAnswerSource = answerReady ? "gpt" : "fallback",
    chartSpec = nextPayload?.chart_spec || nextPayload?.primary_visual || null,
    suggestedQuestions = followupSuggestions,
  }) => ({
    answer: answerReady ? compressAlexaSpeech(answer, fallbackAnswer) : "",
    answer_ready: Boolean(answerReady),
    voice_answer_source: voiceAnswerSource,
    chart_spec: chartSpec,
    payload: nextPayload,
    activeStageIndex: Number(nextPayload?.activeStageIndex || 0),
    suggestedQuestions,
  });

  const buildSingleViewFollowup = async (target, options = {}) => {
    if (!summaryBundle || !target) return null;
    const targetMetrics = Array.isArray(target.metrics) && target.metrics.length
      ? target.metrics
      : (payload?.metrics_needed || [summaryBundle.primaryMetric]);
    const targetGoal = target.goal || "deep_dive";
    const derivedPlan = {
      question_type: targetGoal,
      metrics_needed: targetMetrics,
      time_scope: payload?.time_scope || "last_7_days",
      comparison_mode: targetGoal === "comparison_report" ? "previous_period" : payload?.comparison_mode || "none",
      preferred_chart: target.visual_family || inferVisualForGoal(targetGoal, targetMetrics, payload || {}),
      response_mode: "single_view",
      layout_hint: "single_focus",
      followup_mode: "chart_aware",
      drill_down_candidates: defaultSuggestedQuestions(targetMetrics?.[0], targetGoal),
    };
    const derivedPresentation = {
      response_mode: "single_view",
      layout: "single_focus",
      spoken_answer: payload?.spoken_answer || payload?.voice_answer || fallbackAnswer,
      report_title: sanitizePlainText(target.label || target.title, 80, "Detail"),
      takeaway: fallbackAnswer,
      panels: [{
        panel_id: target.id || target.panel_id || buildPanelId(targetGoal, targetMetrics),
        goal: targetGoal,
        metrics: targetMetrics,
        visual_family: target.visual_family || inferVisualForGoal(targetGoal, targetMetrics, derivedPlan),
        title: sanitizePlainText(target.label || target.title, 80, "Detail"),
        subtitle: sanitizePlainText(target.subtitle, 120, summaryBundle.timeLabel),
      }],
      next_views: nextViews,
      suggested_followup_prompt: payload?.suggested_followup_prompt || "Say tell me more for deeper detail.",
      followup_mode: "chart_aware",
    };

    let presentation = null;
    try {
      presentation = await maybeBuildPresentation(question, derivedPlan, summaryBundle, null, 6000, debug);
    } catch (_) {
      qnaWarn("present", "follow-up GPT presentation failed, using deterministic", { question: question?.slice(0, 40) });
    }
    if (!presentation) presentation = derivedPresentation;
    presentation = {
      ...presentation,
      response_mode: "single_view",
      layout: "single_focus",
      report_title: derivedPresentation.report_title,
      panels: [{
        ...(presentation?.panels?.[0] || {}),
        ...derivedPresentation.panels[0],
      }],
      next_views: nextViews,
      suggested_followup_prompt: derivedPresentation.suggested_followup_prompt,
      followup_mode: "chart_aware",
    };
    const followupVoiceSource = !didTraceUseFallback(debug, "presenter") ? "gpt" : "fallback";

    const nextPayload = buildPayload({
      requestId: payload?.requestId || null,
      question: question || payload?.question || "",
      plan: derivedPlan,
      fetched: null,
      summaryBundle,
      presentation,
      voiceAnswerOverride: "",
      voiceAnswerSource: followupVoiceSource,
      answerReady: true,
      activePanelId: target.id || target.panel_id || buildPanelId(targetGoal, targetMetrics),
      debug,
    });

    return buildFollowupResponse({
      nextPayload,
      answer: nextPayload.voice_answer || fallbackAnswer,
      answerReady: true,
      voiceAnswerSource: nextPayload.voice_answer_source || followupVoiceSource,
      chartSpec: nextPayload.chart_spec,
      suggestedQuestions: sanitizeListText((nextPayload.next_views || []).map((view) => view.label), 2, 80),
    });
  };

  if (isContinueAfterTimeout && summaryBundle) {
    const originalQuestion = payload?.question || question || "";
    const currentPlan = {
      question_type: payload?.question_type || "single_metric_status",
      metrics_needed: payload?.metrics_needed || summaryBundle.metricsShown || [summaryBundle.primaryMetric],
      time_scope: payload?.time_scope || "last_7_days",
      comparison_mode: payload?.comparison_mode || "none",
    };
    const currentChartSpec = activePanel?.chart_spec || payload?.chart_spec || payload?.primary_visual;
    const resumedPayload = setPayloadVoiceState({
      ...payload,
      primary_visual: currentChartSpec,
      chart_spec: currentChartSpec,
      activeStageIndex: Math.max(0, panels.findIndex((p) => p.panel_id === activePanelId)),
    }, payload?.spoken_answer || payload?.voice_answer || fallbackAnswer, payload?.voice_answer_source || "fallback", true, debug);
    return buildFollowupResponse({
      nextPayload: resumedPayload,
      answer: resumedPayload.voice_answer || fallbackAnswer,
      answerReady: true,
      voiceAnswerSource: resumedPayload.voice_answer_source || "fallback",
      chartSpec: currentChartSpec,
    });
  }

  const panelByOrdinal = () => {
    if (!panels.length) return null;
    if (/\b(first|1st|one|top)\b/.test(q)) return panels[0];
    if (/\b(second|2nd|two)\b/.test(q)) return panels[1] || null;
    if (/\b(third|3rd|three)\b/.test(q)) return panels[2] || null;
    if (/\b(fourth|4th|four)\b/.test(q)) return panels[3] || null;
    if (/\b(last|bottom)\b/.test(q)) return panels[panels.length - 1];
    if (/\b(left)\b/.test(q)) return panels[0];
    if (/\b(right)\b/.test(q)) return panels[1] || null;
    return null;
  };

  const buildExplanationAnswer = (panel) => {
    if (!panel) return compressAlexaSpeech(fallbackAnswer);
    const scopedSummary = summaryBundle ? buildMetricScopedSummary(summaryBundle, panel.metrics) : null;
    if (!scopedSummary) return compressAlexaSpeech(panel?.chart_spec?.takeaway || fallbackAnswer, fallbackAnswer);
    if (panel.goal === "relationship_report" && scopedSummary.crossMetricRelationships?.statement) {
      return compressAlexaSpeech(scopedSummary.crossMetricRelationships.statement, fallbackAnswer);
    }
    if (panel.goal === "comparison_report" && Number.isFinite(Number(scopedSummary.previousPeriodComparison?.changePct))) {
      const changePct = Number(scopedSummary.previousPeriodComparison.changePct || 0);
      const direction = changePct > 3 ? "higher" : changePct < -3 ? "lower" : "about the same";
      return compressAlexaSpeech(`This chart shows that ${metricLabel(scopedSummary.primaryMetric)} was ${direction} than the previous period.`, fallbackAnswer);
    }
    if (scopedSummary.sleepQuality?.takeaway && panel.metrics.includes("sleep_minutes")) {
      return compressAlexaSpeech(scopedSummary.sleepQuality.takeaway, fallbackAnswer);
    }
    if (scopedSummary.intradayInsights?.takeaway && supportsIntradayView(scopedSummary, panel.metrics)) {
      return compressAlexaSpeech(scopedSummary.intradayInsights.takeaway, fallbackAnswer);
    }
    return compressAlexaSpeech(panel?.chart_spec?.takeaway || panel?.title || fallbackAnswer, fallbackAnswer);
  };

  const matchedNextView = nextViews.find((view) => {
    const idText = normalizeText(view?.id);
    const labelText = normalizeText(view?.label);
    return (idText && normalizedQuestion.includes(idText))
      || (labelText && normalizedQuestion.includes(labelText));
  }) || null;

  const ordinalPanel = panelByOrdinal();
  const matchedPanel = wantsOverview
    ? panels[0] || null
    : panels.find((panel) => {
        const label = normalizeText(panel?.title);
        const metricText = normalizeText((panel?.metrics || []).map((metric) => metricLabel(metric)).join(" "));
        const goalText = normalizeText(panel?.goal);
        return label && normalizedQuestion.includes(label)
          || (metricText && normalizedQuestion.includes(metricText))
          || (goalText && normalizedQuestion.includes(goalText));
      }) || null;

  const continuedNextView = shouldAdvance
    ? nextViews[activeViewIndex >= 0 ? activeViewIndex + 1 : 0] || nextViews[0] || null
    : null;

  const selectedNextView = matchedNextView
    || continuedNextView
    || nextViews.find((view) => {
      const metricText = normalizeText((view?.metrics || []).map((metric) => metricLabel(metric)).join(" "));
      const goalText = normalizeText(view?.goal);
      return (metricText && normalizedQuestion.includes(metricText))
        || (goalText && normalizedQuestion.includes(goalText));
    }) || null;

  if (isTellMeMore && activePanel && summaryBundle) {
    const deeperView = await buildSingleViewFollowup({
      panel_id: activePanel.panel_id,
      title: `${activePanel.title} detail`,
      subtitle: activePanel.subtitle || summaryBundle.timeLabel,
      goal: "deep_dive",
      metrics: activePanel.metrics,
      visual_family: inferVisualForGoal("deep_dive", activePanel.metrics || [summaryBundle.primaryMetric], payload || {}),
    }, {
      continuationHint: `The user asked for more detail about the current chart "${activePanel.title || "detail"}". Give a deeper analysis with more context and what the data suggests.`,
    });
    if (deeperView) return deeperView;
  }

  if (selectedNextView && summaryBundle) {
    return buildSingleViewFollowup(selectedNextView, {
      continuationHint: `The user asked to focus on "${selectedNextView?.label || "detail"}". Give the deeper spoken explanation for that specific view.`,
    });
  }

  const selectedPanel = ordinalPanel || matchedPanel;
  if (selectedPanel && selectedPanel.chart_spec) {
    const panelAnswer = wantsExplanation
      ? buildExplanationAnswer(selectedPanel)
      : payload?.spoken_answer || payload?.voice_answer || fallbackAnswer;
    const updatedPayload = setPayloadVoiceState({
      ...payload,
      activePanelId: selectedPanel.panel_id,
      activeStageIndex: Math.max(0, panels.findIndex((panel) => panel.panel_id === selectedPanel.panel_id)),
      primary_visual: selectedPanel.chart_spec,
      chart_spec: selectedPanel.chart_spec,
    }, panelAnswer, wantsExplanation ? "gpt" : (payload?.voice_answer_source || "fallback"), wantsExplanation ? true : Boolean(payload?.answer_ready), debug);
    return buildFollowupResponse({
      nextPayload: updatedPayload,
      answer: wantsExplanation ? panelAnswer : "",
      answerReady: wantsExplanation ? true : Boolean(updatedPayload.answer_ready),
      voiceAnswerSource: updatedPayload.voice_answer_source || "fallback",
      chartSpec: selectedPanel.chart_spec,
    });
  }

  if (wantsExplanation && activePanel?.chart_spec) {
    const explanationAnswer = buildExplanationAnswer(activePanel);
    return buildFollowupResponse({
      nextPayload: setPayloadVoiceState({
        ...payload,
        primary_visual: activePanel.chart_spec,
        chart_spec: activePanel.chart_spec,
        activeStageIndex: Math.max(0, panels.findIndex((panel) => panel.panel_id === activePanel.panel_id)),
      }, explanationAnswer, "gpt", true, debug),
      answer: explanationAnswer,
      answerReady: true,
      voiceAnswerSource: "gpt",
      chartSpec: activePanel.chart_spec,
    });
  }

  qnaLog("present", "handling follow-up", {
    question,
    chartType: chartContext?.chartType,
    metricsShown: chartContext?.metricsShown,
  });

  return callOpenAIJson({
      systemPrompt: FOLLOWUP_CONFIG.systemPrompt,
      userPayload: {
        userQuestion: question,
        summary: payload?.summary || null,
      chartContext,
      summaryBundle: summaryBundle
        ? {
            primaryMetric: summaryBundle.primaryMetric,
            secondaryMetric: summaryBundle.secondaryMetric,
            timeLabel: summaryBundle.timeLabel,
            currentPeriodStats: summaryBundle.currentPeriodStats,
            previousPeriodComparison: summaryBundle.previousPeriodComparison,
            anomalies: summaryBundle.anomalies,
            relationship: summaryBundle.crossMetricRelationships,
            storyCandidates: summaryBundle.storyCandidates,
          }
        : null,
      },
      model: FOLLOWUP_CONFIG.model,
      maxTokens: FOLLOWUP_CONFIG.maxTokens,
      temperature: FOLLOWUP_CONFIG.temperature,
      timeoutMs: FOLLOWUP_CONFIG.timeoutMs,
      jsonSchema: FOLLOWUP_CONFIG.jsonSchema,
    onTrace: (trace) => recordTrace(debug, "followup", trace, false),
  }).then((parsed) => {
    if (!parsed?.answer) {
      if (debug?.gpt_trace?.followup) debug.gpt_trace.followup.used_fallback = true;
      return buildFollowupResponse({
        nextPayload: setPayloadVoiceState(payload, fallbackAnswer, "fallback", false, debug),
        answer: "",
        answerReady: false,
        voiceAnswerSource: "fallback",
        suggestedQuestions: sanitizeListText(payload?.suggestedDrillDowns || payload?.suggested_follow_up, 2, 80),
      });
    }
    return buildFollowupResponse({
      nextPayload: setPayloadVoiceState(payload, parsed.answer, "gpt", true, debug),
      answer: parsed.answer,
      answerReady: true,
      voiceAnswerSource: "gpt",
      suggestedQuestions: sanitizeListText(parsed.suggestedQuestions, 2, 80).length
        ? sanitizeListText(parsed.suggestedQuestions, 2, 80)
        : sanitizeListText(payload?.suggestedDrillDowns || payload?.suggested_follow_up, 2, 80),
    });
  }).catch(() => buildFollowupResponse({
    nextPayload: setPayloadVoiceState(payload, fallbackAnswer, "fallback", false, debug),
    answer: "",
    answerReady: false,
    voiceAnswerSource: "fallback",
    suggestedQuestions: sanitizeListText(payload?.suggestedDrillDowns || payload?.suggested_follow_up, 2, 80),
  }));
}

module.exports = {
  answerQuestion,
  buildRichQnaPayload,
  answerFollowupFromPayload,
  buildDefaultReportPlan,
  buildPayload,
  getUserContext,
  inferHeuristicFetchPlan,
  validateReportPlan,
  buildBridgeSpeech,
  buildMicroAnswer,
  buildVisualPayload,
  buildFitbitInternalUrl,
  hydrateIntradayMetricData,
  resolveInternalApiBaseUrl,
};
