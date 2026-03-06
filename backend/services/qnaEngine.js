/* eslint-disable */
// @ts-nocheck
/**
 * backend/services/qnaengine.js
 *
 * Flow:
 * 1) Fast fetch-plan (heuristic first, optional GPT refinement)
 * 2) Fetch Fitbit data in backend code
 * 3) Compute deterministic stats/relationships in backend code
 * 4) Run speech and visuals in parallel from the same derived facts
 * 5) Return the best spoken answer inside the voice deadline
 */

const User = require("../models/Users");
const {
  VISUAL_SYSTEM,
  metricToPalette,
  FETCH_PLANNER_CONFIG,
  PRESENT_CONFIG,
  SPEECH_CONFIG,
  FOLLOWUP_CONFIG,
} = require("../configs/openAiSystemConfigs");
const { callOpenAIJson, callOpenAIStreaming } = require("./openAIClient");
const {
  calculateStats,
  comparePeriods,
  pickHighlight,
  detectAnomalies,
  describeRelationship,
  alignSeriesMap,
} = require("./chartInsightService");
const {
  toMetricSeries,
  toSleepSeries,
  toSleepStageBreakdown,
  sliceLast,
} = require("./chartDataService");
const {
  validateChartSpec,
  buildFallbackChartSpec,
} = require("./chartSpecService");

const DEFAULT_VOICE_DEADLINE_MS = Math.max(
  250,
  Number(process.env.QNA_VOICE_DEADLINE_MS || 4300)
);
const RICH_PRESENT_FAILSAFE_MS = Math.max(
  8000,
  Number(process.env.QNA_RICH_FAILSAFE_MS || 25000)
);

const QNA_DEBUG = process.env.QNA_DEBUG !== "false";

function qnaLog(scope, message, data = null) {
  if (!QNA_DEBUG) return;
  if (data === null || data === undefined) {
    console.log(`[QnA][${scope}] ${message}`);
    return;
  }
  console.log(`[QnA][${scope}] ${message}`, data);
}

function qnaWarn(scope, message, data = null) {
  if (data === null || data === undefined) {
    console.warn(`[QnA][${scope}] ${message}`);
    return;
  }
  console.warn(`[QnA][${scope}] ${message}`, data);
}

function qnaError(scope, message, error = null) {
  if (!error) {
    console.error(`[QnA][${scope}] ${message}`);
    return;
  }
  console.error(`[QnA][${scope}] ${message}`, {
    message: error?.message || String(error),
    stack: error?.stack || null,
  });
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function computeDateWindow(timeScope = "last_7_days", multiplier = 1) {
  const scopeConf =
    VISUAL_SYSTEM.timeScopeConfig?.[timeScope] ||
    VISUAL_SYSTEM.timeScopeConfig.last_7_days;
  const baseDays = scopeConf.baseDays;
  const offsetDays = scopeConf.offsetDays || 0;
  const timeframeLabel = scopeConf.label;

  const now = new Date();
  const end = new Date(now);
  end.setDate(now.getDate() - offsetDays);

  const mult = Math.max(1, Number(multiplier) || 1);
  const windowDays = baseDays * mult;
  const start = new Date(end);
  start.setDate(end.getDate() - (windowDays - 1));

  return {
    baseDays,
    windowDays,
    startDate: formatDate(start),
    endDate: formatDate(end),
    timeframeLabel,
  };
}

async function getUserContext(username) {
  qnaLog("context", "loading user context", {
    username: String(username || "").slice(0, 30),
  });

  try {
    const user = await User.findOne({
      username: String(username || "").toLowerCase(),
    });

    if (!user) {
      qnaWarn("context", "user not found");
      return null;
    }

    const context = {
      age: user?.userProfile?.age || null,
      healthGoals: Array.isArray(user?.userProfile?.healthGoals)
        ? user.userProfile.healthGoals
        : [],
      preferences: {
        dailyStepGoal:
          Number(user?.userProfile?.preferences?.dailyStepGoal) || 10000,
        sleepGoalMinutes:
          Number(user?.userProfile?.preferences?.sleepGoalMinutes) || 480,
      },
    };

    qnaLog("context", "user context loaded", {
      hasAge: context.age != null,
      healthGoalsCount: context.healthGoals.length,
      preferences: context.preferences,
    });

    return context;
  } catch (err) {
    qnaError("context", "failed loading user context", err);
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

function toTitleCase(text = "") {
  const source = String(text || "").trim();
  return source ? `${source.charAt(0).toUpperCase()}${source.slice(1)}` : "";
}

function sanitizePlainText(value, max = 220, fallback = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return fallback;
  return text.slice(0, max);
}

function sanitizeListText(values, maxItems = 4, maxLen = 90) {
  if (!Array.isArray(values)) return [];
  return values
    .map((v) => sanitizePlainText(v, maxLen, ""))
    .filter(Boolean)
    .slice(0, maxItems);
}

function compressAlexaSpeech(text = "", fallback = "Here is your health summary.") {
  const source = sanitizePlainText(text, 240, fallback);
  const sentenceCap = Math.max(
    1,
    Number(VISUAL_SYSTEM.voice.maxSentences || 1)
  );
  const sentenceParts = source
    .split(/[.!?]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, sentenceCap);

  const combined = sentenceParts.length
    ? `${sentenceParts.join(". ")}.`
    : source;

  const words = combined
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, VISUAL_SYSTEM.voice.maxWords)
    .join(" ");

  if (words.length <= VISUAL_SYSTEM.voice.maxChars) return words;
  return `${words
    .slice(0, VISUAL_SYSTEM.voice.maxChars - 3)
    .trimEnd()}...`;
}

function formatMetricValue(value, unit = "") {
  const n = Number(value);
  if (!Number.isFinite(n)) return unit ? `0 ${unit}` : "0";
  const rounded = Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 10) / 10;
  return unit ? `${rounded.toLocaleString()} ${unit}` : `${rounded.toLocaleString()}`;
}

function inferTimeScope(question) {
  const q = String(question || "").toLowerCase();
  if (/\blast\s*night\b/.test(q)) return "last_night";
  if (/\byesterday\b/.test(q)) return "yesterday";
  if (/\btoday\b/.test(q)) return "today";
  if (/\bthis\s*week\b/.test(q)) return "this_week";
  if (/\blast\s*week\b/.test(q)) return "last_week";
  if (/\b(month|30\s*days|thirty\s*days|4\s*weeks)\b/.test(q))
    return "last_30_days";
  if (/\b(7\s*days|seven\s*days|past week|last 7 days)\b/.test(q))
    return "last_7_days";
  return null;
}

function normalizeTimeScopeForQuestion(questionType, timeScope) {
  if (questionType === "relationship" || questionType === "comparison") {
    if (["today", "yesterday", "last_night"].includes(timeScope)) {
      return "last_7_days";
    }
  }
  return timeScope;
}

function defaultTimeScopeForMetric(metricKey) {
  if (metricKey === "sleep_minutes") return "last_night";
  if (String(metricKey).endsWith("_intraday")) return "today";
  return "today";
}

function getGoalForMetric(metricKey, userContext) {
  if (metricKey === "steps" || metricKey === "steps_intraday") {
    return Number(userContext?.preferences?.dailyStepGoal || 10000);
  }
  if (metricKey === "sleep_minutes") {
    return (
      Math.round(
        (Number(userContext?.preferences?.sleepGoalMinutes || 480) / 60) * 10
      ) / 10
    );
  }
  return null;
}

function normalizeMetric(rawMetric) {
  const metric = String(rawMetric || "").trim().toLowerCase();
  if (VISUAL_SYSTEM.allowed.metrics.includes(metric)) return metric;
  return VISUAL_SYSTEM.metricAliases?.[metric] || null;
}

function detectIntradayIntent(q) {
  return /\b(by hour|hourly|during the day|through the day|this morning|this afternoon|today over time|spike|spikes|dip|dips)\b/.test(
    q
  );
}

function extractMentionedMetrics(q) {
  const metrics = [];
  const push = (metric) => {
    if (metric && !metrics.includes(metric)) metrics.push(metric);
  };

  if (/\bsleep|slept|bed|nap\b/.test(q)) push("sleep_minutes");
  if (/\befficiency\b/.test(q)) push("sleep_efficiency");
  if (/\bawake|wake\b/.test(q)) push("wake_minutes");
  if (/\bresting\b|\bheart\b|\bpulse\b|\bbpm\b/.test(q)) push("resting_hr");
  if (/\bhrv|variability\b/.test(q)) push("hrv");
  if (/\bcalorie|burn\b/.test(q)) push("calories");
  if (/\bdistance|mile|miles\b/.test(q)) push("distance");
  if (/\bfloor|floors\b/.test(q)) push("floors");
  if (/\belevation\b/.test(q)) push("elevation");
  if (/\bstep|steps|walk|walking|activity|movement\b/.test(q)) push("steps");

  if (!metrics.length && /\benergy\b/.test(q)) {
    push(VISUAL_SYSTEM.proxyMap.energy || "steps");
  }
  if (!metrics.length) push("steps");

  if (detectIntradayIntent(q)) {
    if (metrics.includes("resting_hr")) {
      metrics[metrics.indexOf("resting_hr")] = "heart_intraday";
    }
    if (metrics.includes("steps")) {
      metrics[metrics.indexOf("steps")] = "steps_intraday";
    }
    if (metrics.includes("calories")) {
      metrics[metrics.indexOf("calories")] = "calories_intraday";
    }
    if (metrics.includes("distance")) {
      metrics[metrics.indexOf("distance")] = "distance_intraday";
    }
    if (metrics.includes("floors")) {
      metrics[metrics.indexOf("floors")] = "floors_intraday";
    }
  }

  return metrics.slice(0, 4);
}

function inferHeuristicFetchPlan(question = "") {
  const q = String(question || "").toLowerCase();

  let question_type = "status";
  if (/\b(compare|compared|versus|vs|previous|last week|better than|worse than)\b/.test(q))
    question_type = "comparison";
  if (/\b(pattern|trend|usually|often|which day|over time)\b/.test(q))
    question_type = "pattern";
  if (/\b(why|dip|drop|spike|explain|what does that mean)\b/.test(q))
    question_type = "explain_chart";
  if (/\b(affect|impact|relationship|related|correlat|influence)\b/.test(q))
    question_type = "relationship";
  if (/\b(goal|target|close to|progress|met my goal)\b/.test(q))
    question_type = "goal";
  if (/\b(what should i do|tip|tips|advice|improve)\b/.test(q))
    question_type = "coaching";
  if (/\b(reminder|medication|medicine|pill)\b/.test(q))
    question_type = "reminder";

  let metrics_needed = extractMentionedMetrics(q);

  if (question_type === "relationship" && metrics_needed.length === 1) {
    const primary = metrics_needed[0];
    if (primary === "sleep_minutes") metrics_needed.push("steps");
    else if (primary === "steps" || primary === "steps_intraday")
      metrics_needed.push("sleep_minutes");
    else metrics_needed.push("steps");
  }

  const inferredScope =
    inferTimeScope(q) || defaultTimeScopeForMetric(metrics_needed[0]);
  const time_scope = normalizeTimeScopeForQuestion(question_type, inferredScope);
  const comparison_mode =
    question_type === "comparison" ? "previous_period" : "none";

  let preferred_chart = "bar";
  if (question_type === "goal") preferred_chart = "gauge";
  else if (question_type === "comparison" && metrics_needed.length === 1)
    preferred_chart = "grouped_bar";
  else if (question_type === "relationship" || metrics_needed.length > 1)
    preferred_chart = "line";
  else if (
    question_type === "coaching" ||
    question_type === "reminder" ||
    question_type === "explain_chart"
  )
    preferred_chart = "list_summary";
  else if (
    ["today", "yesterday", "last_night"].includes(time_scope) &&
    getGoalForMetric(metrics_needed[0], null)
  )
    preferred_chart = "gauge";
  else if (
    time_scope === "last_30_days" ||
    String(metrics_needed[0]).endsWith("_intraday")
  )
    preferred_chart = "line";

  const plan = {
    question_type,
    metrics_needed: metrics_needed.slice(0, 4),
    time_scope,
    comparison_mode,
    preferred_chart,
  };

  qnaLog("planner", "heuristic fetch plan built", {
    question,
    ...plan,
  });

  return plan;
}

function normalizeFetchPlan(rawPlan, fallbackPlan) {
  const plan = rawPlan && typeof rawPlan === "object" ? rawPlan : {};
  const question_type = VISUAL_SYSTEM.allowed.questionTypes.includes(
    plan.question_type
  )
    ? plan.question_type
    : fallbackPlan.question_type;

  const metrics_needed = Array.isArray(plan.metrics_needed)
    ? plan.metrics_needed.map(normalizeMetric).filter(Boolean).slice(0, 4)
    : [];

  const finalMetrics = metrics_needed.length
    ? metrics_needed
    : fallbackPlan.metrics_needed;

  const selectedTimeScope = VISUAL_SYSTEM.app.supportedTimeScopes.includes(
    plan.time_scope
  )
    ? plan.time_scope
    : fallbackPlan.time_scope;

  const time_scope = normalizeTimeScopeForQuestion(
    question_type,
    selectedTimeScope
  );

  const comparison_mode = VISUAL_SYSTEM.allowed.comparisonModes.includes(
    plan.comparison_mode
  )
    ? plan.comparison_mode
    : fallbackPlan.comparison_mode;

  const preferred_chart = VISUAL_SYSTEM.allowed.chartTypes.includes(
    plan.preferred_chart
  )
    ? plan.preferred_chart
    : fallbackPlan.preferred_chart;

  return {
    question_type,
    metrics_needed: finalMetrics,
    time_scope,
    comparison_mode,
    preferred_chart,
  };
}

async function maybeRefineFetchPlan(
  question,
  heuristicPlan,
  timeoutMs = FETCH_PLANNER_CONFIG.timeoutMs
) {
  qnaLog("planner", "starting optional GPT fetch-plan refinement", {
    question,
    heuristicPlan,
    timeoutMs,
  });

  const parsed = await callOpenAIJson({
    systemPrompt: FETCH_PLANNER_CONFIG.systemPrompt,
    userPayload: {
      question,
      heuristicPlan,
      allowedQuestionTypes: VISUAL_SYSTEM.allowed.questionTypes,
      allowedMetrics: VISUAL_SYSTEM.allowed.metrics,
      allowedTimeScopes: VISUAL_SYSTEM.app.supportedTimeScopes,
      allowedComparisonModes: VISUAL_SYSTEM.allowed.comparisonModes,
      allowedChartTypes: VISUAL_SYSTEM.allowed.chartTypes,
    },
    model: FETCH_PLANNER_CONFIG.model,
    maxTokens: FETCH_PLANNER_CONFIG.maxTokens,
    temperature: FETCH_PLANNER_CONFIG.temperature,
    timeoutMs,
    jsonSchema: FETCH_PLANNER_CONFIG.jsonSchema,
  });

  if (!parsed) {
    qnaWarn(
      "planner",
      "GPT fetch-plan refinement returned null, using heuristic plan"
    );
    return heuristicPlan;
  }

  qnaLog("planner", "GPT fetch-plan refinement succeeded", parsed);
  return normalizeFetchPlan(parsed, heuristicPlan);
}

async function fetchJsonWithTimeout(url, timeoutMs = 3200) {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    Math.max(500, Number(timeoutMs) || 3200)
  );

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Fetch failed (${response.status}): ${body.slice(0, 180)}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildFitbitInternalUrl({ username, metricKey, startDate, endDate }) {
  const base = process.env.INTERNAL_API_URL || "http://localhost:5001";
  const user = String(username || "").toLowerCase();

  if (
    metricKey === "sleep_minutes" ||
    metricKey === "sleep_efficiency" ||
    metricKey === "wake_minutes"
  ) {
    return `${base}/api/fitbit/${user}/sleep/range/date/${startDate}/${endDate}`;
  }

  if (metricKey === "resting_hr") {
    return `${base}/api/fitbit/${user}/heart/range/date/${startDate}/${endDate}`;
  }

  if (metricKey === "heart_intraday") {
    return `${base}/api/fitbit/${user}/heart/intraday/${startDate}`;
  }

  if (metricKey === "steps_intraday") {
    return `${base}/api/fitbit/${user}/activities/intraday/steps/${startDate}`;
  }

  if (metricKey === "calories_intraday") {
    return `${base}/api/fitbit/${user}/activities/intraday/calories/${startDate}`;
  }

  if (metricKey === "distance_intraday") {
    return `${base}/api/fitbit/${user}/activities/intraday/distance/${startDate}`;
  }

  if (metricKey === "floors_intraday") {
    return `${base}/api/fitbit/${user}/activities/intraday/floors/${startDate}`;
  }

  if (metricKey === "calories") {
    return `${base}/api/fitbit/${user}/activities/range/calories/date/${startDate}/${endDate}`;
  }

  if (metricKey === "distance") {
    return `${base}/api/fitbit/${user}/activities/range/distance/date/${startDate}/${endDate}`;
  }

  if (metricKey === "floors") {
    return `${base}/api/fitbit/${user}/activities/range/floors/date/${startDate}/${endDate}`;
  }

  if (metricKey === "elevation") {
    return `${base}/api/fitbit/${user}/activities/range/elevation/date/${startDate}/${endDate}`;
  }

  if (metricKey === "hrv") {
    return `${base}/api/fitbit/${user}/hrv/range/date/${startDate}/${endDate}`;
  }

  return `${base}/api/fitbit/${user}/activities/range/steps/date/${startDate}/${endDate}`;
}

function toMetricPoints(metricKey, rawPayload, windowDays) {
  if (metricKey === "sleep_minutes") return toSleepSeries(rawPayload, windowDays).sleep;
  if (metricKey === "sleep_efficiency") return toSleepSeries(rawPayload, windowDays).efficiency;
  if (metricKey === "wake_minutes") return toSleepSeries(rawPayload, windowDays).wakeMinutes;
  return toMetricSeries(metricKey, rawPayload, windowDays);
}

async function fetchRequestedData({
  username,
  plan,
  fetchTimeoutMs = 5300,
}) {
  qnaLog("fetch", "starting Fitbit fetch bundle", {
    username,
    metrics_needed: plan.metrics_needed,
    time_scope: plan.time_scope,
    comparison_mode: plan.comparison_mode,
    fetchTimeoutMs,
  });

  const metrics_needed = Array.isArray(plan.metrics_needed)
    ? plan.metrics_needed
    : ["steps"];
  const comparisonNeeded = plan.comparison_mode === "previous_period";
  const window = computeDateWindow(plan.time_scope, comparisonNeeded ? 2 : 1);

  const metricsData = {};

  for (const metricKey of metrics_needed) {
    const url = buildFitbitInternalUrl({
      username,
      metricKey,
      startDate: window.startDate,
      endDate: window.endDate,
    });

    qnaLog("fetch", "fetching metric", {
      metricKey,
      startDate: window.startDate,
      endDate: window.endDate,
      url,
    });

    const raw = await fetchJsonWithTimeout(url, fetchTimeoutMs);
    const allPoints = toMetricPoints(metricKey, raw, window.windowDays);

    metricsData[metricKey] = {
      raw,
      all: allPoints,
      current: sliceLast(allPoints, window.baseDays),
      previous: comparisonNeeded
        ? allPoints.slice(0, Math.max(0, allPoints.length - window.baseDays))
        : [],
    };

    qnaLog("fetch", "metric fetched and parsed", {
      metricKey,
      totalPoints: allPoints.length,
      currentPoints: metricsData[metricKey].current.length,
      previousPoints: metricsData[metricKey].previous.length,
    });
  }

  const primaryMetric = metrics_needed[0];
  const secondaryMetric = metrics_needed[1] || null;

  qnaLog("fetch", "completed Fitbit fetch bundle", {
    primaryMetric,
    secondaryMetric,
    metrics_needed,
    window,
  });

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
  };
}

function buildBarOption({
  labels,
  values,
  yAxisName,
  seriesName,
  palette,
  highlightIndex = null,
  goalLine = null,
}) {
  return {
    tooltip: { trigger: "axis" },
    grid: { left: 52, right: 20, top: 30, bottom: 40 },
    xAxis: {
      type: "category",
      data: labels,
      axisLabel: {
        color: "#334155",
        fontSize: VISUAL_SYSTEM.chartDefaults.axisFontSize,
      },
      axisTick: { show: false },
    },
    yAxis: {
      type: "value",
      name: yAxisName,
      axisLabel: {
        color: "#334155",
        fontSize: VISUAL_SYSTEM.chartDefaults.axisFontSize,
      },
      splitLine: { lineStyle: { color: "#E2E8F0" } },
    },
    series: [
      {
        type: "bar",
        name: seriesName,
        data: values,
        itemStyle: {
          borderRadius: [
            VISUAL_SYSTEM.chartDefaults.barRadius,
            VISUAL_SYSTEM.chartDefaults.barRadius,
            0,
            0,
          ],
          color: (params) => {
            if (
              Number.isFinite(highlightIndex) &&
              params.dataIndex === highlightIndex
            ) {
              return palette.accent;
            }
            return palette.primary;
          },
        },
        label: {
          show: values.length <= 8,
          position: "top",
          color: "#334155",
          fontSize: 12,
        },
        markLine: Number.isFinite(Number(goalLine))
          ? {
              symbol: ["none", "none"],
              lineStyle: { type: "dashed", color: palette.secondary, width: 2 },
              label: { formatter: "Goal" },
              data: [{ yAxis: Number(goalLine) }],
            }
          : undefined,
      },
    ],
  };
}

function buildDailyComparisonOption(currentPoints, previousPoints, metricKey) {
  const palette = metricToPalette(metricKey);
  const labels = currentPoints.map((p) => p.label);
  const currentValues = currentPoints.map((p) => Number(p.value) || 0);
  const previousValues = previousPoints
    .slice(-currentPoints.length)
    .map((p) => Number(p.value) || 0);

  return {
    tooltip: { trigger: "axis" },
    legend: { top: 6, textStyle: { color: "#334155" } },
    grid: { left: 52, right: 20, top: 42, bottom: 40 },
    xAxis: {
      type: "category",
      data: labels,
      axisLabel: {
        color: "#334155",
        fontSize: VISUAL_SYSTEM.chartDefaults.axisFontSize,
      },
      axisTick: { show: false },
    },
    yAxis: {
      type: "value",
      name: metricUnit(metricKey),
      axisLabel: {
        color: "#334155",
        fontSize: VISUAL_SYSTEM.chartDefaults.axisFontSize,
      },
      splitLine: { lineStyle: { color: "#E2E8F0" } },
    },
    series: [
      {
        type: "bar",
        name: "Previous",
        data: previousValues,
        itemStyle: {
          color: palette.secondary,
          borderRadius: [10, 10, 0, 0],
        },
      },
      {
        type: "bar",
        name: "Current",
        data: currentValues,
        itemStyle: {
          color: palette.primary,
          borderRadius: [10, 10, 0, 0],
        },
      },
    ],
  };
}

function buildLineOption({
  labels,
  values,
  yAxisName,
  seriesName,
  palette,
  goalLine = null,
}) {
  return {
    tooltip: { trigger: "axis" },
    grid: { left: 52, right: 20, top: 30, bottom: 40 },
    xAxis: {
      type: "category",
      data: labels,
      axisLabel: {
        color: "#334155",
        fontSize: VISUAL_SYSTEM.chartDefaults.axisFontSize,
      },
      axisTick: { show: false },
    },
    yAxis: {
      type: "value",
      name: yAxisName,
      axisLabel: {
        color: "#334155",
        fontSize: VISUAL_SYSTEM.chartDefaults.axisFontSize,
      },
      splitLine: { lineStyle: { color: "#E2E8F0" } },
    },
    series: [
      {
        type: "line",
        name: seriesName,
        data: values,
        symbolSize: 8,
        itemStyle: { color: palette.primary },
        lineStyle: {
          color: palette.primary,
          width: VISUAL_SYSTEM.chartDefaults.lineWidth,
        },
        areaStyle: { opacity: 0.14, color: palette.secondary },
        markLine: Number.isFinite(Number(goalLine))
          ? {
              symbol: ["none", "none"],
              lineStyle: { type: "dashed", color: palette.accent, width: 2 },
              label: { formatter: "Goal" },
              data: [{ yAxis: Number(goalLine) }],
            }
          : undefined,
      },
    ],
  };
}

function buildMultiMetricLineOption({ labels, seriesDefs }) {
  return {
    tooltip: { trigger: "axis" },
    legend: { top: 6, textStyle: { color: "#334155" } },
    grid: { left: 56, right: 56, top: 42, bottom: 40 },
    xAxis: {
      type: "category",
      data: labels,
      axisLabel: {
        color: "#334155",
        fontSize: VISUAL_SYSTEM.chartDefaults.axisFontSize,
      },
      axisTick: { show: false },
    },
    yAxis: {
      type: "value",
      axisLabel: {
        color: "#334155",
        fontSize: VISUAL_SYSTEM.chartDefaults.axisFontSize,
      },
      splitLine: { lineStyle: { color: "#E2E8F0" } },
    },
    series: seriesDefs.map((series) => ({
      type: "line",
      name: series.name,
      data: series.values,
      connectNulls: false,
      symbolSize: 7,
      itemStyle: { color: series.color },
      lineStyle: {
        color: series.color,
        width: VISUAL_SYSTEM.chartDefaults.lineWidth,
      },
    })),
  };
}

function buildGaugeOption({ value, goal, name, palette }) {
  const max = Math.max(1, Number(goal) || 100);
  return {
    series: [
      {
        type: "gauge",
        max,
        progress: {
          show: true,
          width: 18,
          itemStyle: { color: palette.primary },
        },
        axisLine: { lineStyle: { width: 18, color: [[1, "#E2E8F0"]] } },
        pointer: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
        detail: {
          valueAnimation: false,
          formatter: ({ value: raw }) => `${Math.round(raw)}`,
          fontSize: VISUAL_SYSTEM.chartDefaults.gaugeFontSize,
          fontWeight: 700,
          color: palette.text,
        },
        title: {
          offsetCenter: [0, "76%"],
          fontSize: 15,
          color: "#475569",
        },
        data: [
          {
            value: Math.max(0, Math.min(max, Number(value) || 0)),
            name,
          },
        ],
      },
    ],
  };
}

function buildListSummaryOption(items = []) {
  return {
    items,
    graphic: [
      {
        type: "text",
        left: "5%",
        top: "10%",
        style: {
          text: items.map((item) => `• ${item}`).join("\n"),
          fontSize: 17,
          lineHeight: 30,
          fill: "#1E293B",
        },
      },
    ],
  };
}

function buildPieOption({ slices, palette }) {
  const colors = palette?.series || VISUAL_SYSTEM.palettes.fallback.series;
  return {
    tooltip: { trigger: "item", formatter: "{b}: {c} ({d}%)" },
    legend: {
      orient: "horizontal",
      bottom: 6,
      textStyle: { color: "#334155", fontSize: 13 },
    },
    series: [
      {
        type: "pie",
        radius: ["35%", "65%"],
        center: ["50%", "45%"],
        avoidLabelOverlap: true,
        itemStyle: { borderRadius: 6, borderColor: "#fff", borderWidth: 2 },
        label: { show: true, fontSize: 13, color: "#334155" },
        emphasis: { label: { show: true, fontWeight: "bold" } },
        data: slices.map((s, i) => ({
          value: Number(s.value) || 0,
          name: String(s.name || s.label || `Slice ${i + 1}`),
          itemStyle: { color: colors[i % colors.length] },
        })),
      },
    ],
  };
}

function buildDerivedSummary({ plan, fetched, userContext }) {
  const primaryMetric = fetched.primaryMetric;
  const secondaryMetric = fetched.secondaryMetric;
  const metricSeriesMap = {};
  const metricStatsMap = {};

  (fetched.metrics_needed || []).forEach((metricKey) => {
    const currentSeries = fetched.metricsData?.[metricKey]?.current || [];
    metricSeriesMap[metricKey] = currentSeries;
    metricStatsMap[metricKey] = calculateStats(
      currentSeries,
      getGoalForMetric(metricKey, userContext)
    );
  });

  const primaryStats =
    metricStatsMap[primaryMetric] || calculateStats([]);
  const comparisonStats =
    plan.comparison_mode === "previous_period"
      ? comparePeriods(fetched.primaryAll, fetched.primaryWindow.baseDays)
      : null;

  const highlight = pickHighlight(fetched.primaryCurrent);
  const anomalies = detectAnomalies(fetched.primaryCurrent).slice(0, 3);

  let relationship = null;
  if (
    plan.question_type === "relationship" &&
    secondaryMetric &&
    fetched.secondaryCurrent?.length
  ) {
    relationship = describeRelationship(
      fetched.primaryCurrent,
      fetched.secondaryCurrent,
      {
        shiftSecondaryByDays:
          primaryMetric === "sleep_minutes" &&
          secondaryMetric !== "sleep_minutes"
            ? 1
            : 0,
        primaryMetricLabel: metricLabel(primaryMetric),
      }
    );
  }

  const alignedMultiMetric = alignSeriesMap(metricSeriesMap);
  const sleepStageBreakdown =
    primaryMetric === "sleep_minutes"
      ? toSleepStageBreakdown(fetched.primaryRaw)
      : null;

  const result = {
    primaryMetric,
    secondaryMetric,
    metrics: fetched.metrics_needed,
    metricSeriesMap,
    metricStatsMap,
    alignedMultiMetric,
    timeLabel: fetched.primaryWindow.timeframeLabel,
    unit: metricUnit(primaryMetric),
    secondaryUnit: secondaryMetric ? metricUnit(secondaryMetric) : null,
    primaryStats,
    comparisonStats,
    highlight,
    anomalies,
    relationship,
    currentPoints: fetched.primaryCurrent,
    previousPoints: fetched.primaryPrevious,
    currentLabels: fetched.primaryCurrent.map((p) => p.label),
    currentValues: fetched.primaryCurrent.map((p) => Number(p.value) || 0),
    secondaryPoints: fetched.secondaryCurrent || [],
    secondaryValues:
      fetched.secondaryCurrent?.map((p) => Number(p.value) || 0) || [],
    goal: getGoalForMetric(primaryMetric, userContext),
    sleepStageBreakdown,
  };

  qnaLog("derive", "derived summary built", {
    primaryMetric,
    secondaryMetric,
    metrics: fetched.metrics_needed,
    timeLabel: fetched.primaryWindow.timeframeLabel,
    primaryStats,
    comparisonStats,
    relationship,
    highlight,
    anomalyCount: anomalies.length,
    sleepStageBreakdown: sleepStageBreakdown
      ? sleepStageBreakdown.length
      : 0,
  });

  return result;
}

function formatSleepDurationSpeech(hoursValue) {
  const totalMinutes = Math.max(0, Math.round((Number(hoursValue) || 0) * 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes} minutes`;
  if (minutes <= 0) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${hours} hour${hours === 1 ? "" : "s"} ${minutes} minute${
    minutes === 1 ? "" : "s"
  }`;
}

function metricSubject(metricKey) {
  return metricLabel(metricKey);
}

function highlightSentence(derivedFacts) {
  const highlight = derivedFacts?.highlight;
  if (!highlight?.label) return "";
  if (highlight.reason === "lowest") return `${highlight.label} was your lowest point.`;
  if (highlight.reason === "highest") return `${highlight.label} was your highest point.`;
  return `${highlight.label} stood out in this chart.`;
}

function buildMicroAnswer({ questionType, derivedFacts }) {
  qnaLog("speech", "building deterministic micro-answer", {
    questionType,
    primaryMetric: derivedFacts?.primaryMetric,
    metrics: derivedFacts?.metrics,
  });

  const qType = String(questionType || "status");
  const facts = derivedFacts || {};
  const metricKey = facts.primaryMetric || "steps";
  const subject = metricSubject(metricKey);
  const unit = metricUnit(metricKey);
  const currentValue = Number(
    facts?.primaryStats?.current || facts?.primaryStats?.avg || 0
  );
  const goal = Number(facts?.goal || facts?.primaryStats?.goal);
  const timeLabel = facts?.timeLabel || "this period";

  if ((facts.metrics || []).length > 2) {
    qnaLog("speech", "micro-answer path: multi-metric");
    const names = facts.metrics.map((m) => metricLabel(m)).join(", ");
    return compressAlexaSpeech(
      `I compared ${names} over ${timeLabel}. The screen shows how they moved together.`,
      "I compared several metrics for you."
    );
  }

  if (qType === "relationship") {
    qnaLog("speech", "micro-answer path: relationship");
    const relationshipStatement = sanitizePlainText(
      facts?.relationship?.statement,
      220,
      ""
    );
    if (relationshipStatement) {
      return compressAlexaSpeech(
        relationshipStatement,
        "On higher days, the other metric tended to change too."
      );
    }
    return "I do not have enough overlapping days to show a reliable relationship yet.";
  }

  if (qType === "goal" && Number.isFinite(goal) && goal > 0) {
    qnaLog("speech", "micro-answer path: goal");
    const percent = Math.max(0, Math.round((currentValue / goal) * 100));
    return compressAlexaSpeech(
      `You have reached ${percent} percent of your ${subject} goal.`,
      "You are making progress toward your goal."
    );
  }

  if (qType === "comparison" && facts?.comparisonStats) {
    qnaLog("speech", "micro-answer path: comparison");
    const comparison = facts.comparisonStats;
    const changePct = Number(comparison.changePct || 0);
    const absChange = Math.abs(changePct);
    const intensity =
      absChange >= 15 ? "much" : absChange >= 5 ? "a little" : "";
    let directionText = "about the same as";
    if (changePct > 3) {
      directionText = intensity
        ? `${intensity} higher than`
        : "higher than";
    }
    if (changePct < -3) {
      directionText = intensity
        ? `${intensity} lower than`
        : "lower than";
    }
    const anchor = highlightSentence(facts);
    return compressAlexaSpeech(
      `Your ${subject} in ${timeLabel} is ${directionText} the previous period. ${anchor}`.trim(),
      `Your ${subject} is about the same as the previous period.`
    );
  }

  if (qType === "explain_chart") {
    qnaLog("speech", "micro-answer path: explain");
    const anchor = highlightSentence(facts);
    if (anchor)
      return compressAlexaSpeech(anchor, "One point stands out in this chart.");
    return "One point stands out in this chart.";
  }

  if (qType === "coaching") {
    qnaLog("speech", "micro-answer path: coaching");
    if (metricKey === "sleep_minutes") {
      return compressAlexaSpeech(
        "A consistent bedtime and a short wind-down routine can help raise your sleep duration.",
        "A consistent routine can help improve this trend."
      );
    }
    if (metricKey === "steps" || metricKey === "steps_intraday") {
      return compressAlexaSpeech(
        "A short ten minute walk after meals is a simple way to raise your daily steps.",
        "A short walk can help improve this trend."
      );
    }
    return "A steady routine with sleep, hydration, and light activity can help this trend.";
  }

  if (metricKey === "sleep_minutes") {
    qnaLog("speech", "micro-answer path: sleep default");
    const sleepText = formatSleepDurationSpeech(currentValue);
    const anchor = highlightSentence(facts);
    return compressAlexaSpeech(
      `You slept about ${sleepText} ${
        timeLabel === "last night" ? "last night" : `in ${timeLabel}`
      }. ${anchor}`.trim(),
      "Here is your sleep summary."
    );
  }

  qnaLog("speech", "micro-answer path: default");
  const valueText = formatMetricValue(currentValue, unit);
  const anchor = highlightSentence(facts);
  return compressAlexaSpeech(
    `Your ${subject} is about ${valueText} for ${timeLabel}. ${anchor}`.trim(),
    "Here is your health summary."
  );
}

function defaultSuggestedQuestions(primaryMetric) {
  if (primaryMetric === "sleep_minutes") {
    return [
      "How does this compare to last week?",
      "Which night stood out most?",
      "Does my sleep affect my activity?",
    ];
  }
  if (primaryMetric === "resting_hr" || primaryMetric === "heart_intraday") {
    return [
      "How does this compare to last week?",
      "Which point stood out most?",
      "Explain this chart to me.",
    ];
  }
  return [
    "How does this compare to last week?",
    "Which day stood out most?",
    "Explain this chart to me.",
  ];
}

function buildPresentationFallback(question, plan, derived) {
  const metric = toTitleCase(metricLabel(derived.primaryMetric));
  const timeLabel = derived.timeLabel;
  const unit = derived.unit;
  const stats = derived.primaryStats;
  const questions = defaultSuggestedQuestions(derived.primaryMetric);

  let shortSpeech = `${metric} averaged ${formatMetricValue(
    stats.avg,
    unit
  )} over ${timeLabel}.`;
  let shortText = `${metric} averaged ${formatMetricValue(
    stats.avg,
    unit
  )} over ${timeLabel}.`;

  if (plan.question_type === "comparison" && derived.comparisonStats) {
    const direction =
      derived.comparisonStats.direction === "up"
        ? "higher"
        : derived.comparisonStats.direction === "down"
        ? "lower"
        : "about the same";

    shortSpeech = `${metric} was ${direction} than the previous period.`;
    shortText = `${metric} was ${direction} than the previous period. This period averaged ${formatMetricValue(
      derived.comparisonStats.currentAvg,
      unit
    )}, compared with ${formatMetricValue(
      derived.comparisonStats.previousAvg,
      unit
    )} before.`;
  }

  if (plan.question_type === "relationship" && derived.relationship) {
    shortSpeech = compressAlexaSpeech(derived.relationship.statement);
    shortText = derived.relationship.statement;
  }

  if ((derived.metrics || []).length > 2) {
    shortSpeech = `I compared several metrics over ${timeLabel}.`;
    shortText = `I compared ${derived.metrics
      .map((m) => metricLabel(m))
      .join(", ")} over ${timeLabel}.`;
  }

  return {
    summary: { shortSpeech, shortText },
    stages: [
      {
        id: "stage_1",
        title: `${metric} overview`,
        cue: `Here is your ${metric.toLowerCase()} overview.`,
        speech: shortSpeech,
        screenText: shortText,
        stage_type:
          plan.question_type === "comparison"
            ? "comparison"
            : plan.question_type === "relationship" ||
              (derived.metrics || []).length > 1
            ? "relationship"
            : "summary",
        chart_type: plan.preferred_chart,
        takeaway: shortText,
        icon: "spark",
      },
    ],
    suggestedQuestions: questions,
  };
}

async function maybeBuildPresentation(
  question,
  plan,
  derived,
  userContext,
  timeoutMs = PRESENT_CONFIG.timeoutMs
) {
  const compactFacts = {
    question,
    question_type: plan.question_type,
    metrics: plan.metrics_needed,
    time_scope: plan.time_scope,
    comparison_mode: plan.comparison_mode,
    userContext: {
      age: userContext?.age || null,
      stepGoal: userContext?.preferences?.dailyStepGoal || null,
      sleepGoalMinutes: userContext?.preferences?.sleepGoalMinutes || null,
    },
    derivedFacts: {
      timeLabel: derived.timeLabel,
      primaryMetric: derived.primaryMetric,
      secondaryMetric: derived.secondaryMetric,
      metrics: derived.metrics,
      unit: derived.unit,
      primaryStats: derived.primaryStats,
      comparisonStats: derived.comparisonStats,
      relationship: derived.relationship,
      highlight: derived.highlight,
      anomalies: derived.anomalies,
      currentPoints: derived.currentPoints.slice(-7).map((p) => ({
        label: p.label,
        value: p.value,
      })),
      metricStatsMap: Object.fromEntries(
        Object.entries(derived.metricStatsMap || {}).map(([metricKey, stats]) => [
          metricKey,
          {
            avg: stats.avg,
            current: stats.current,
            high: stats.high,
            low: stats.low,
          },
        ])
      ),
    },
  };

  qnaLog("visuals", "starting GPT presentation build", {
    question,
    question_type: plan.question_type,
    metrics: plan.metrics_needed,
    timeoutMs,
  });

  const parsed = await callOpenAIJson({
    systemPrompt: PRESENT_CONFIG.systemPrompt,
    userPayload: compactFacts,
    model: PRESENT_CONFIG.model,
    maxTokens: PRESENT_CONFIG.maxTokens,
    temperature: PRESENT_CONFIG.temperature,
    timeoutMs,
    jsonSchema: PRESENT_CONFIG.jsonSchema,
  });

  if (!parsed || !parsed.summary || !Array.isArray(parsed.stages)) {
    qnaWarn("visuals", "GPT presentation returned null/invalid, using fallback");
    return buildPresentationFallback(question, plan, derived);
  }

  const fallback = buildPresentationFallback(question, plan, derived);

  const summary = {
    shortSpeech: compressAlexaSpeech(
      parsed.summary.shortSpeech,
      fallback.summary.shortSpeech
    ),
    shortText: sanitizePlainText(
      parsed.summary.shortText,
      300,
      fallback.summary.shortText
    ),
  };

  const stages = parsed.stages
    .map((stage, index) => ({
      id: sanitizePlainText(stage.id, 20, `stage_${index + 1}`),
      title: sanitizePlainText(stage.title, 80, `Stage ${index + 1}`),
      cue: sanitizePlainText(stage.cue, 120, `Here is stage ${index + 1}.`),
      speech: compressAlexaSpeech(stage.speech, summary.shortSpeech),
      screenText: sanitizePlainText(stage.screenText, 280, summary.shortText),
      stage_type: VISUAL_SYSTEM.allowed.stageTypes.includes(stage.stage_type)
        ? stage.stage_type
        : "summary",
      chart_type: VISUAL_SYSTEM.allowed.chartTypes.includes(stage.chart_type)
        ? stage.chart_type
        : plan.preferred_chart,
      takeaway: sanitizePlainText(stage.takeaway, 220, summary.shortText),
      icon: sanitizePlainText(stage.icon, 40, "spark"),
    }))
    .slice(0, VISUAL_SYSTEM.app.maxStages);

  qnaLog("visuals", "GPT presentation succeeded", {
    stageCount: stages.length,
    suggestedQuestions: parsed.suggestedQuestions || [],
  });

  return {
    summary,
    stages: stages.length ? stages : fallback.stages,
    suggestedQuestions: sanitizeListText(parsed.suggestedQuestions, 4, 80)
      .length
      ? sanitizeListText(parsed.suggestedQuestions, 4, 80)
      : fallback.suggestedQuestions,
  };
}

function renderStageChart(stage, plan, derived, userContext) {
  const primaryMetric = derived.primaryMetric;
  const palette = metricToPalette(
    stage.stage_type === "relationship" ? "relationship" : primaryMetric
  );
  const unit = metricUnit(primaryMetric);
  const goal = getGoalForMetric(primaryMetric, userContext);
  const highlight = derived.highlight;
  const currentLabels = derived.currentPoints.map((p) => p.label);
  const currentValues = derived.currentPoints.map((p) => Number(p.value) || 0);

  const multiMetricCount = Object.keys(
    derived.alignedMultiMetric?.valuesByMetric || {}
  ).length;

  if (
    (plan.question_type === "relationship" || multiMetricCount > 1) &&
    multiMetricCount > 1
  ) {
    const seriesDefs = Object.keys(
      derived.alignedMultiMetric.valuesByMetric
    ).map((metricKey, idx) => {
      const pal = metricToPalette(metricKey);
      return {
        name: toTitleCase(metricLabel(metricKey)),
        values: derived.alignedMultiMetric.valuesByMetric[metricKey],
        color: pal.series[idx % pal.series.length],
      };
    });

    return validateChartSpec(
      {
        chart_type: "line",
        title: stage.title,
        subtitle: derived.timeLabel,
        takeaway: stage.takeaway,
        icon: stage.icon,
        highlight: null,
        option: buildMultiMetricLineOption({
          labels: derived.alignedMultiMetric.labels,
          seriesDefs,
        }),
        suggested_follow_up: [],
      },
      stage.title
    );
  }

  if (plan.question_type === "comparison" && derived.comparisonStats) {
    return validateChartSpec(
      {
        chart_type: "grouped_bar",
        title: stage.title,
        subtitle: derived.timeLabel,
        takeaway: stage.takeaway,
        icon: stage.icon,
        highlight: null,
        option: buildDailyComparisonOption(
          derived.comparisonStats.current,
          derived.comparisonStats.previous,
          primaryMetric
        ),
        suggested_follow_up: [],
      },
      stage.title
    );
  }

  if (stage.stage_type === "tip" || stage.stage_type === "explanation") {
    const items = [];
    items.push(stage.screenText);
    if (derived.highlight?.label) {
      items.push(`${derived.highlight.label} stood out most in this period.`);
    }
    if (derived.anomalies?.length) {
      items.push(
        `I noticed ${derived.anomalies.length} unusual point${
          derived.anomalies.length > 1 ? "s" : ""
        }.`
      );
    }

    return validateChartSpec(
      {
        chart_type: "list_summary",
        title: stage.title,
        subtitle: derived.timeLabel,
        takeaway: stage.takeaway,
        icon: stage.icon,
        highlight: null,
        option: buildListSummaryOption(items.slice(0, 3)),
        suggested_follow_up: [],
      },
      stage.title
    );
  }

  if (stage.chart_type === "pie" && derived.sleepStageBreakdown?.length) {
    return validateChartSpec(
      {
        chart_type: "pie",
        title: stage.title,
        subtitle: derived.timeLabel,
        takeaway: stage.takeaway,
        icon: stage.icon,
        highlight: null,
        option: buildPieOption({
          slices: derived.sleepStageBreakdown,
          palette,
        }),
        suggested_follow_up: [],
      },
      stage.title
    );
  }

  if (stage.chart_type === "gauge" && Number.isFinite(goal)) {
    return validateChartSpec(
      {
        chart_type: "gauge",
        title: stage.title,
        subtitle: derived.timeLabel,
        takeaway: stage.takeaway,
        icon: stage.icon,
        highlight: null,
        option: buildGaugeOption({
          value: derived.primaryStats.current || derived.primaryStats.avg,
          goal,
          name: `${toTitleCase(metricLabel(primaryMetric))} goal`,
          palette,
        }),
        suggested_follow_up: [],
      },
      stage.title
    );
  }

  if (
    stage.chart_type === "line" ||
    String(primaryMetric).endsWith("_intraday") ||
    currentValues.length >= 14
  ) {
    return validateChartSpec(
      {
        chart_type: "line",
        title: stage.title,
        subtitle: derived.timeLabel,
        takeaway: stage.takeaway,
        icon: stage.icon,
        highlight: highlight
          ? {
              label: highlight.label,
              value: highlight.value,
              reason: highlight.reason,
            }
          : null,
        option: buildLineOption({
          labels: currentLabels,
          values: currentValues,
          yAxisName: unit,
          seriesName: toTitleCase(metricLabel(primaryMetric)),
          palette,
          goalLine: Number.isFinite(goal) ? goal : null,
        }),
        suggested_follow_up: [],
      },
      stage.title
    );
  }

  return validateChartSpec(
    {
      chart_type: "bar",
      title: stage.title,
      subtitle: derived.timeLabel,
      takeaway: stage.takeaway,
      icon: stage.icon,
      highlight: highlight
        ? {
            label: highlight.label,
            value: highlight.value,
            reason: highlight.reason,
          }
        : null,
      option: buildBarOption({
        labels: currentLabels,
        values: currentValues,
        yAxisName: unit,
        seriesName: toTitleCase(metricLabel(primaryMetric)),
        palette,
        highlightIndex: highlight
          ? derived.currentPoints.findIndex((p) => p.date === highlight.date)
          : null,
        goalLine: Number.isFinite(goal) ? goal : null,
      }),
      suggested_follow_up: [],
    },
    stage.title
  );
}

function buildBridgeSpeech(plan) {
  const primaryMetric = Array.isArray(plan?.metrics_needed)
    ? plan.metrics_needed[0]
    : "steps";
  const timeScope = plan?.time_scope || VISUAL_SYSTEM.app.defaultTimeScope;
  const timeLabel =
    VISUAL_SYSTEM.timeScopeConfig?.[timeScope]?.label || "this period";

  return compressAlexaSpeech(
    `I am checking your ${metricLabel(
      primaryMetric
    )} for ${timeLabel} and building the full answer now.`,
    "I am getting that ready now."
  );
}

function buildPayloadFromPresentation({
  question,
  plan,
  fetched,
  derived,
  presentation,
  userContext,
  voiceAnswerOverride = "",
}) {
  const stages = (Array.isArray(presentation?.stages)
    ? presentation.stages
    : []
  ).map((stageDraft, idx) => {
    const chart_spec = renderStageChart(stageDraft, plan, derived, userContext);
    return {
      id: stageDraft.id || `stage_${idx + 1}`,
      cue: stageDraft.cue || `Stage ${idx + 1}`,
      speech:
        stageDraft.speech ||
        presentation?.summary?.shortSpeech ||
        "Here is your summary.",
      voice_answer:
        stageDraft.speech ||
        presentation?.summary?.shortSpeech ||
        "Here is your summary.",
      screenText: stageDraft.screenText || presentation?.summary?.shortText || "",
      suggested_follow_up:
        presentation?.suggestedQuestions ||
        defaultSuggestedQuestions(derived.primaryMetric),
      chart_spec,
    };
  });

  const fallbackSpeech = buildBridgeSpeech(plan);
  const summarySpeech = compressAlexaSpeech(
    voiceAnswerOverride || presentation?.summary?.shortSpeech,
    fallbackSpeech
  );
  const summaryText = sanitizePlainText(
    presentation?.summary?.shortText,
    300,
    sanitizePlainText(summarySpeech, 240, "Here is your health summary.")
  );

  return {
    question,
    question_type: plan.question_type,
    metrics_needed: plan.metrics_needed,
    time_scope: plan.time_scope,
    comparison_mode: plan.comparison_mode,
    voice_answer: summarySpeech,
    summary: {
      shortSpeech: summarySpeech,
      shortText: summaryText,
    },
    suggested_follow_up:
      presentation?.suggestedQuestions ||
      defaultSuggestedQuestions(derived.primaryMetric),
    chart_spec:
      stages[0]?.chart_spec ||
      buildFallbackChartSpec("Health Summary", "I could not prepare that chart."),
    stages,
    stageCount: stages.length || 1,
    activeStageIndex: 0,
    chart_context: {
      question_type: plan.question_type,
      metrics_needed: plan.metrics_needed,
      time_scope: plan.time_scope,
      comparison_mode: plan.comparison_mode,
      primary_metric: fetched?.primaryMetric || derived?.primaryMetric || null,
      secondary_metric:
        fetched?.secondaryMetric || derived?.secondaryMetric || null,
      derived,
      updated_at: Date.now(),
    },
  };
}

function buildSpeechPromptPayload(question, plan, derived) {
  const facts = {
    question,
    questionType: plan.question_type,
    metric: derived.primaryMetric,
    metrics: derived.metrics,
    timeLabel: derived.timeLabel,
    unit: derived.unit,
    avg: derived.primaryStats?.avg,
    current: derived.primaryStats?.current,
    high: derived.primaryStats?.high,
    low: derived.primaryStats?.low,
    goal: derived.goal,
    comparisonStats: derived.comparisonStats || null,
    relationship: derived.relationship || null,
    highlight: derived.highlight || null,
  };
  return JSON.stringify(facts);
}

async function buildSpeechAnswer({ question, plan, derived, microAnswer }) {
  qnaLog("speech", "starting GPT speech generation", {
    question,
    question_type: plan.question_type,
    metrics: derived.metrics,
  });

  try {
    const text = await callOpenAIStreaming({
      systemPrompt: SPEECH_CONFIG.systemPrompt,
      userMessage: buildSpeechPromptPayload(question, plan, derived),
      model: SPEECH_CONFIG.model,
      maxTokens: SPEECH_CONFIG.maxTokens,
      temperature: SPEECH_CONFIG.temperature,
      timeoutMs: Math.max(
        SPEECH_CONFIG.timeoutMs || 0,
        DEFAULT_VOICE_DEADLINE_MS
      ),
    });

    if (text) {
      qnaLog("speech", "GPT speech generation succeeded", {
        speech: text,
      });
      return compressAlexaSpeech(text, microAnswer);
    }
  } catch (err) {
    qnaWarn("speech", "GPT speech generation failed, falling back to micro-answer", {
      reason: err?.message || "unknown",
    });
  }

  return null;
}

async function buildVisualPayload({
  question,
  plan,
  fetched,
  derived,
  userContext,
  allowPresenterLLM = true,
}) {
  qnaLog("visuals", "starting visual payload build", {
    question,
    question_type: plan.question_type,
    metrics: plan.metrics_needed,
    preferred_chart: plan.preferred_chart,
    allowPresenterLLM,
  });

  const presentation = allowPresenterLLM
    ? await maybeBuildPresentation(
        question,
        plan,
        derived,
        userContext,
        RICH_PRESENT_FAILSAFE_MS
      )
    : buildPresentationFallback(question, plan, derived);

  qnaLog("visuals", "visual payload built", {
    stageCount: presentation?.stages?.length || 0,
    suggestedQuestions: presentation?.suggestedQuestions || [],
  });

  return buildPayloadFromPresentation({
    question,
    plan,
    fetched,
    derived,
    presentation,
    userContext,
  });
}

async function selectVoiceAnswer({
  microAnswer,
  speechPromise,
  deadlineMs = DEFAULT_VOICE_DEADLINE_MS,
}) {
  qnaLog("voice-select", "choosing spoken answer", {
    deadlineMs,
    hasSpeechPromise: !!speechPromise,
  });

  if (!speechPromise || typeof speechPromise.then !== "function") {
    qnaLog("voice-select", "using deterministic micro-answer");
    return { status: "partial", voiceAnswer: microAnswer };
  }

  const budgetMs = Math.max(0, Number(deadlineMs) || 0);
  if (budgetMs <= 0) {
    qnaLog("voice-select", "using deterministic micro-answer");
    return { status: "partial", voiceAnswer: microAnswer };
  }

  const winner = await Promise.race([
    speechPromise
      .then((speech) => ({ type: "speech", speech }))
      .catch(() => ({ type: "error" })),
    new Promise((resolve) =>
      setTimeout(() => resolve({ type: "timeout" }), budgetMs)
    ),
  ]);

  if (winner?.type === "speech" && winner.speech) {
    qnaLog("voice-select", "using GPT speech answer");
    return { status: "complete", voiceAnswer: winner.speech };
  }

  qnaLog("voice-select", "using deterministic micro-answer");
  return { status: "partial", voiceAnswer: microAnswer };
}

async function answerQuestion({
  username,
  question,
  voiceDeadlineMs = DEFAULT_VOICE_DEADLINE_MS,
  userContext = null,
  allowFetchPlannerLLM = false,
  allowPresenterLLM = true,
  enableVisualContinuation = false,
  fetchPlanTimeoutMs = FETCH_PLANNER_CONFIG.timeoutMs,
  fetchTimeoutMs = 3200,
}) {
  qnaLog("answerQuestion", "starting QnA request", {
    username,
    question,
    voiceDeadlineMs,
    allowFetchPlannerLLM,
    allowPresenterLLM,
    enableVisualContinuation,
  });

  const q = sanitizePlainText(question, 280, "");
  const u = sanitizePlainText(username, 60, "amy").toLowerCase();
  const ctx = userContext || (await getUserContext(u)) || null;

  const heuristicPlan = inferHeuristicFetchPlan(q);
  const plan = allowFetchPlannerLLM
    ? await maybeRefineFetchPlan(q, heuristicPlan, fetchPlanTimeoutMs)
    : heuristicPlan;

  qnaLog("answerQuestion", "fetch plan ready", plan);

  if (plan.question_type === "reminder") {
    const reminderPayload = {
      question: q,
      question_type: "reminder",
      metrics_needed: [],
      time_scope: plan.time_scope,
      comparison_mode: "none",
      voice_answer:
        "The reminder flow handles medication schedules. Ask me about sleep, steps, heart rate, calories, or HRV here.",
      suggested_follow_up: ["What is my next reminder?"],
      chart_spec: validateChartSpec(
        {
          chart_type: "list_summary",
          title: "Reminder help",
          subtitle: "Quick guidance",
          takeaway:
            "Use the reminder flow for medications and scheduled reminders.",
          option: buildListSummaryOption([
            "The reminder workflow handles medication and scheduled reminders.",
            "This QnA screen focuses on Fitbit trends, comparisons, and explanations.",
            "Ask about sleep, steps, heart rate, calories, or HRV here.",
          ]),
        },
        "Reminder help"
      ),
      stageCount: 1,
      activeStageIndex: 0,
      stages: [],
    };

    reminderPayload.stages = [
      {
        id: "stage_1",
        cue: "Reminder help",
        speech: reminderPayload.voice_answer,
        voice_answer: reminderPayload.voice_answer,
        suggested_follow_up: reminderPayload.suggested_follow_up,
        chart_spec: reminderPayload.chart_spec,
      },
    ];

    qnaLog("answerQuestion", "returning reminder response", {
      stageCount: 1,
    });

    return {
      status: "complete",
      voiceAnswer: reminderPayload.voice_answer,
      payload: reminderPayload,
      planner: plan,
      rawData: null,
      userContext: ctx,
      visualContinuationPromise: null,
    };
  }

  const fetched = await fetchRequestedData({
    username: u,
    plan,
    fetchTimeoutMs,
  });

  const noData =
    !fetched.primaryCurrent?.length ||
    fetched.primaryCurrent.every((p) => Number(p.value) === 0);

  if (noData) {
    qnaWarn("answerQuestion", "no Fitbit data available for request", {
      metric: fetched.primaryMetric,
      timeLabel: fetched.primaryWindow.timeframeLabel,
    });

    const noDataVoice = `I do not have enough ${metricLabel(
      fetched.primaryMetric
    )} data for ${fetched.primaryWindow.timeframeLabel} yet.`;

    const fallback = buildFallbackChartSpec(
      `No ${metricLabel(fetched.primaryMetric)} data`,
      noDataVoice
    );

    const payload = {
      question: q,
      question_type: plan.question_type,
      metrics_needed: plan.metrics_needed,
      time_scope: plan.time_scope,
      comparison_mode: plan.comparison_mode,
      voice_answer: noDataVoice,
      suggested_follow_up: ["Try again after syncing your Fitbit."],
      chart_spec: fallback,
      stages: [
        {
          id: "stage_1",
          cue: fallback.title,
          voice_answer: noDataVoice,
          speech: noDataVoice,
          suggested_follow_up: ["Try again after syncing your Fitbit."],
          chart_spec: fallback,
        },
      ],
      stageCount: 1,
      activeStageIndex: 0,
      chart_context: {
        question_type: plan.question_type,
        metrics_needed: plan.metrics_needed,
        time_scope: plan.time_scope,
      },
    };

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

  const derived = buildDerivedSummary({
    plan,
    fetched,
    userContext: ctx,
  });

  qnaLog("answerQuestion", "derived facts ready", {
    primaryMetric: derived.primaryMetric,
    metrics: derived.metrics,
    timeLabel: derived.timeLabel,
  });

  const microAnswer = buildMicroAnswer({
    questionType: plan.question_type,
    derivedFacts: derived,
  });

  qnaLog("answerQuestion", "micro-answer ready", {
    microAnswer,
  });

  const deterministicPresentation = buildPresentationFallback(q, plan, derived);
  deterministicPresentation.summary.shortSpeech = microAnswer;
  if (
    Array.isArray(deterministicPresentation.stages) &&
    deterministicPresentation.stages[0]
  ) {
    deterministicPresentation.stages[0].speech = microAnswer;
  }

  const deterministicPayload = buildPayloadFromPresentation({
    question: q,
    plan,
    fetched,
    derived,
    presentation: deterministicPresentation,
    userContext: ctx,
    voiceAnswerOverride: microAnswer,
  });

  const speechPromise = buildSpeechAnswer({
    question: q,
    plan,
    derived,
    microAnswer,
  });

  const visualPromise = enableVisualContinuation
    ? buildVisualPayload({
        question: q,
        plan,
        fetched,
        derived,
        userContext: ctx,
        allowPresenterLLM,
      })
    : null;

  const voiceResult = await selectVoiceAnswer({
    microAnswer,
    speechPromise,
    deadlineMs: voiceDeadlineMs,
  });

  qnaLog("answerQuestion", "voice answer selected", {
    status: voiceResult.status,
    voiceAnswer: voiceResult.voiceAnswer,
  });

  qnaLog("answerQuestion", "returning response", {
    status: voiceResult.status || "partial",
    stageCount: deterministicPayload.stageCount,
    hasVisualContinuation: !!visualPromise,
  });

  return {
    status: voiceResult.status || "partial",
    voiceAnswer: voiceResult.voiceAnswer,
    payload: deterministicPayload,
    planner: plan,
    rawData: fetched,
    userContext: ctx,
    visualContinuationPromise: visualPromise,
  };
}

async function buildRichQnaPayload({
  username,
  question,
  userContext = null,
  allowFetchPlannerLLM = true,
  allowPresenterLLM = true,
  fetchPlanTimeoutMs = FETCH_PLANNER_CONFIG.timeoutMs,
  presentTimeoutMs = PRESENT_CONFIG.timeoutMs,
  fetchTimeoutMs = 3200,
}) {
  qnaLog("buildRichQnaPayload", "starting rich payload build", {
    username,
    question,
    allowFetchPlannerLLM,
    allowPresenterLLM,
    fetchPlanTimeoutMs,
    presentTimeoutMs,
  });

  const q = sanitizePlainText(question, 280, "");
  const u = sanitizePlainText(username, 60, "amy").toLowerCase();
  const ctx = userContext || (await getUserContext(u)) || null;

  const heuristicPlan = inferHeuristicFetchPlan(q);
  const plan = allowFetchPlannerLLM
    ? await maybeRefineFetchPlan(q, heuristicPlan, fetchPlanTimeoutMs)
    : heuristicPlan;

  qnaLog("buildRichQnaPayload", "plan ready", plan);

  if (plan.question_type === "reminder") {
    const reminderPayload = {
      question: q,
      question_type: "reminder",
      metrics_needed: [],
      time_scope: plan.time_scope,
      comparison_mode: "none",
      voice_answer: buildBridgeSpeech(plan),
      suggested_follow_up: ["What is my next reminder?"],
      chart_spec: validateChartSpec(
        {
          chart_type: "list_summary",
          title: "Reminder help",
          subtitle: "Quick guidance",
          takeaway:
            "Use the reminder flow for medications and scheduled reminders.",
          option: buildListSummaryOption([
            "The reminder workflow handles medication and scheduled reminders.",
            "This QnA screen focuses on Fitbit trends, comparisons, and explanations.",
            "Ask about sleep, steps, heart rate, calories, or HRV here.",
          ]),
        },
        "Reminder help"
      ),
      stages: [],
      stageCount: 1,
      activeStageIndex: 0,
      chart_context: {
        question_type: "reminder",
        metrics_needed: [],
        time_scope: plan.time_scope,
      },
    };

    reminderPayload.stages = [
      {
        id: "stage_1",
        cue: "Reminder help",
        speech: reminderPayload.voice_answer,
        voice_answer: reminderPayload.voice_answer,
        suggested_follow_up: reminderPayload.suggested_follow_up,
        chart_spec: reminderPayload.chart_spec,
      },
    ];

    return {
      payload: reminderPayload,
      planner: plan,
      rawData: null,
      userContext: ctx,
      bridgeSpeech: buildBridgeSpeech(plan),
    };
  }

  const fetched = await fetchRequestedData({
    username: u,
    plan,
    fetchTimeoutMs,
  });

  qnaLog("buildRichQnaPayload", "Fitbit data fetched", {
    metrics: fetched.metrics_needed,
    primaryMetric: fetched.primaryMetric,
    secondaryMetric: fetched.secondaryMetric,
  });

  const noData =
    !fetched.primaryCurrent?.length ||
    fetched.primaryCurrent.every((p) => Number(p.value) === 0);

  if (noData) {
    const fallback = buildFallbackChartSpec(
      `No ${metricLabel(fetched.primaryMetric)} data`,
      `I do not have enough ${metricLabel(
        fetched.primaryMetric
      )} data for ${fetched.primaryWindow.timeframeLabel} yet.`
    );

    const payload = {
      question: q,
      question_type: plan.question_type,
      metrics_needed: plan.metrics_needed,
      time_scope: plan.time_scope,
      comparison_mode: plan.comparison_mode,
      voice_answer: `I do not have enough ${metricLabel(
        fetched.primaryMetric
      )} data for ${fetched.primaryWindow.timeframeLabel} yet.`,
      suggested_follow_up: ["Try again after syncing your Fitbit."],
      chart_spec: fallback,
      stages: [
        {
          id: "stage_1",
          cue: fallback.title,
          voice_answer: `I do not have enough ${metricLabel(
            fetched.primaryMetric
          )} data for ${fetched.primaryWindow.timeframeLabel} yet.`,
          speech: `I do not have enough ${metricLabel(
            fetched.primaryMetric
          )} data for ${fetched.primaryWindow.timeframeLabel} yet.`,
          suggested_follow_up: ["Try again after syncing your Fitbit."],
          chart_spec: fallback,
        },
      ],
      stageCount: 1,
      activeStageIndex: 0,
      chart_context: {
        question_type: plan.question_type,
        metrics_needed: plan.metrics_needed,
        time_scope: plan.time_scope,
      },
    };

    return {
      payload,
      planner: plan,
      rawData: fetched,
      userContext: ctx,
      bridgeSpeech: buildBridgeSpeech(plan),
    };
  }

  const derived = buildDerivedSummary({
    plan,
    fetched,
    userContext: ctx,
  });

  const presentation = allowPresenterLLM
    ? await maybeBuildPresentation(q, plan, derived, ctx, presentTimeoutMs)
    : buildPresentationFallback(q, plan, derived);

  const payload = buildPayloadFromPresentation({
    question: q,
    plan,
    fetched,
    derived,
    presentation,
    userContext: ctx,
  });

  qnaLog("buildRichQnaPayload", "rich payload ready", {
    stageCount: payload.stageCount,
    voice_answer: payload.voice_answer,
  });

  return {
    payload,
    planner: plan,
    rawData: fetched,
    userContext: ctx,
    bridgeSpeech: buildBridgeSpeech(plan),
  };
}

async function answerFollowupFromPayload({ payload, question }) {
  qnaLog("followup", "starting follow-up answer", {
    question,
    activeStageIndex: payload?.activeStageIndex,
    activeStageTitle:
      payload?.stages?.[payload?.activeStageIndex || 0]?.chart_spec?.title ||
      null,
  });

  const activeStage = Array.isArray(payload?.stages)
    ? payload.stages[payload.activeStageIndex || 0]
    : null;

  const parsed = await callOpenAIJson({
    systemPrompt: FOLLOWUP_CONFIG.systemPrompt,
    userPayload: {
      userQuestion: question,
      summary: payload?.summary || null,
      chartContext: payload?.chart_context || null,
      activeStage: {
        cue: activeStage?.cue || "",
        takeaway: activeStage?.chart_spec?.takeaway || "",
        highlight: activeStage?.chart_spec?.highlight || null,
        title: activeStage?.chart_spec?.title || "",
      },
    },
    model: FOLLOWUP_CONFIG.model,
    maxTokens: FOLLOWUP_CONFIG.maxTokens,
    temperature: FOLLOWUP_CONFIG.temperature,
    timeoutMs: FOLLOWUP_CONFIG.timeoutMs,
    jsonSchema: FOLLOWUP_CONFIG.jsonSchema,
  });

  if (parsed?.answer) {
    qnaLog("followup", "GPT follow-up answer succeeded", {
      answer: parsed.answer,
    });

    return {
      answer: compressAlexaSpeech(
        parsed.answer,
        activeStage?.chart_spec?.takeaway || "Here is what stands out."
      ),
      suggestedQuestions: sanitizeListText(parsed.suggestedQuestions, 4, 80),
    };
  }

  qnaWarn("followup", "using fallback follow-up answer");

  return {
    answer: compressAlexaSpeech(
      activeStage?.chart_spec?.takeaway ||
        payload?.summary?.shortText ||
        "Here is what stands out."
    ),
    suggestedQuestions: sanitizeListText(payload?.suggested_follow_up, 4, 80),
  };
}

module.exports = {
  answerQuestion,
  buildRichQnaPayload,
  answerFollowupFromPayload,
  getUserContext,
  inferHeuristicFetchPlan,
  buildBridgeSpeech,
  buildMicroAnswer,
  buildSpeechAnswer,
  buildVisualPayload,
  selectVoiceAnswer,
};