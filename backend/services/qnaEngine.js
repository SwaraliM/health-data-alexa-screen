/**
 * backend/services/qnaEngine.js
 *
 * Hybrid planner + deterministic rendering pipeline.
 *
 * Flow:
 * 1) Interpret question (heuristic + optional LLM planner refinement)
 * 2) Fetch needed Fitbit data in backend code
 * 3) Compute aggregates/highlights in backend code
 * 4) Build one deterministic chart_spec (ECharts option)
 * 5) Validate/sanitize chart_spec before sending to frontend
 */

const User = require("../models/Users");
const { VISUAL_SYSTEM, metricToPalette, PHIA_QNA_CONFIG } = require("../configs/openAiSystemConfigs");
const { callOpenAIJson } = require("./openAIClient");
const { calculateStats, comparePeriods, pickHighlight, describeRelationship } = require("./chartInsightService");
const { toMetricSeries, toSleepSeries, sliceLast } = require("./chartDataService");
const { validateChartSpec, buildFallbackChartSpec } = require("./chartSpecService");

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function computeDateWindow(timeScope = "last_7_days", multiplier = 1) {
  const baseDays = timeScope === "last_30_days" ? 30 : 7;
  const windowDays = baseDays * Math.max(1, Number(multiplier) || 1);
  const end = new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - (windowDays - 1));

  return {
    baseDays,
    windowDays,
    startDate: formatDate(start),
    endDate: formatDate(end),
    timeframeLabel: timeScope === "last_30_days" ? "last 30 days" : "last 7 days",
  };
}

async function getUserContext(username) {
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
  } catch (_) {
    return null;
  }
}

function metricLabel(metricKey) {
  if (metricKey === "sleep_minutes") return "sleep";
  if (metricKey === "resting_hr") return "resting heart rate";
  if (metricKey === "calories") return "calories";
  if (metricKey === "hrv") return "HRV";
  return "steps";
}

function metricUnit(metricKey) {
  if (metricKey === "sleep_minutes") return "hours";
  if (metricKey === "resting_hr") return "bpm";
  if (metricKey === "calories") return "cal";
  if (metricKey === "hrv") return "ms";
  return "steps";
}

function toTitleCase(text = "") {
  const source = String(text || "").trim();
  return source ? `${source.charAt(0).toUpperCase()}${source.slice(1)}` : "";
}

function formatMetricValue(value, unit = "") {
  const n = Number(value);
  if (!Number.isFinite(n)) return unit ? `0 ${unit}` : "0";
  const rounded = Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 10) / 10;
  return unit ? `${rounded.toLocaleString()} ${unit}` : `${rounded.toLocaleString()}`;
}

function compressAlexaSpeech(text, fallback = "Here is your quick summary.") {
  const source = String(text || "").trim();
  if (!source) return fallback;
  const firstSentence = source.split(/[.!?]/).map((s) => s.trim()).find(Boolean) || source;
  const words = firstSentence
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, VISUAL_SYSTEM.app.voiceMaxWords)
    .join(" ");
  if (words.length <= 140) return words;
  return `${words.slice(0, 137).trimEnd()}...`;
}

function inferHeuristicPlan(question = "") {
  const q = String(question || "").toLowerCase();

  let questionType = "status";
  if (/\b(compare|compared|versus|vs\.?|previous|last week|week over week)\b/.test(q)) questionType = "comparison";
  if (/\b(goal|target|progress|close to|completion|complete|met)\b/.test(q)) questionType = "goal";
  if (/\b(pattern|trend|usually|often|which day|timeline|over time)\b/.test(q)) questionType = "pattern";
  if (/\b(why|dip|drop|spike|stand out|outlier|what happened)\b/.test(q)) questionType = "explain_chart";
  if (/\b(relationship|related|affect|impact|correlat|influence)\b/.test(q)) questionType = "relationship";
  if (/\b(reminder|medication|medicine|pill)\b/.test(q)) questionType = "reminder";
  if (/\b(what should i do|coach|improve|advice)\b/.test(q)) questionType = "coaching";

  let primaryMetric = "steps";
  if (/\bsleep|slept|bed|nap\b/.test(q)) primaryMetric = "sleep_minutes";
  else if (/\bresting\b|\bheart\b|\bpulse\b|\bbpm\b/.test(q)) primaryMetric = "resting_hr";
  else if (/\bcalorie|burned|energy burn\b/.test(q)) primaryMetric = "calories";
  else if (/\bhrv|variability\b/.test(q)) primaryMetric = "hrv";

  let secondaryMetric = null;
  if (questionType === "relationship") {
    if (primaryMetric === "sleep_minutes") secondaryMetric = "steps";
    else if (primaryMetric === "steps") secondaryMetric = "sleep_minutes";
    else secondaryMetric = "steps";
  }

  let timeScope = VISUAL_SYSTEM.app.defaultTimeScope;
  if (/\b(month|30 days|thirty days|4 weeks)\b/.test(q)) timeScope = "last_30_days";

  const comparisonMode = questionType === "comparison" ? "previous_period" : "none";

  let chartType = "bar";
  if (questionType === "goal") chartType = "gauge";
  else if (questionType === "pattern") chartType = "line";
  else if (questionType === "relationship") chartType = "grouped_bar";
  else if (questionType === "reminder" || questionType === "coaching" || questionType === "unsupported") chartType = "list_summary";

  if (/\b(distribution|breakdown|share|portion|percent)\b/.test(q)) chartType = "pie";

  return {
    question_type: questionType,
    metrics_needed: secondaryMetric ? [primaryMetric, secondaryMetric] : [primaryMetric],
    time_scope: timeScope,
    comparison_mode: comparisonMode,
    voice_answer: `I am checking your ${metricLabel(primaryMetric)} for the ${timeScope === "last_30_days" ? "last 30 days" : "last 7 days"}.`,
    suggested_follow_up: [
      `What stands out most in my ${metricLabel(primaryMetric)} this week?`,
      `How does this compare with the previous period?`,
    ],
    chart_spec: {
      chart_type: chartType,
      title: `${toTitleCase(metricLabel(primaryMetric))} overview`,
      subtitle: timeScope === "last_30_days" ? "Last 30 days" : "Last 7 days",
      takeaway: "I prepared a simple summary chart.",
    },
  };
}

function sanitizePlannerArray(values = [], allow = []) {
  if (!Array.isArray(values)) return [];
  if (!Array.isArray(allow) || !allow.length) {
    return values
      .map((v) => String(v || "").trim())
      .filter(Boolean);
  }
  const allowedSet = new Set(allow);
  const out = values
    .map((v) => String(v || "").trim())
    .filter((v) => allowedSet.has(v));
  return [...new Set(out)];
}

function normalizePlan(rawPlan, fallbackPlan) {
  const allowed = VISUAL_SYSTEM.allowed;
  const plan = rawPlan && typeof rawPlan === "object" ? rawPlan : {};

  const questionType = allowed.questionTypes.includes(plan.question_type)
    ? plan.question_type
    : fallbackPlan.question_type;

  const metricsNeeded = sanitizePlannerArray(plan.metrics_needed, allowed.metrics);
  const resolvedMetrics = metricsNeeded.length ? metricsNeeded.slice(0, 2) : fallbackPlan.metrics_needed;

  const timeScope = allowedQuestionValue(allowed, "supportedTimeScopes", plan.time_scope, fallbackPlan.time_scope);
  const comparisonMode = allowed.comparisonModes.includes(plan.comparison_mode)
    ? plan.comparison_mode
    : fallbackPlan.comparison_mode;

  const rawChartType = String(plan?.chart_spec?.chart_type || "").toLowerCase();
  const chartType = allowed.chartTypes.includes(rawChartType)
    ? rawChartType
    : fallbackPlan.chart_spec.chart_type;

  const fallbackSubtitle = timeScope === "last_30_days" ? "Last 30 days" : "Last 7 days";
  const plannerFollowUps = sanitizeListText(plan.suggested_follow_up, 4, 80);

  return {
    question_type: questionType,
    metrics_needed: resolvedMetrics,
    time_scope: timeScope,
    comparison_mode: comparisonMode,
    voice_answer: sanitizePlainText(plan.voice_answer, 180, fallbackPlan.voice_answer),
    suggested_follow_up: plannerFollowUps.length
      ? plannerFollowUps
      : fallbackPlan.suggested_follow_up,
    chart_spec: {
      chart_type: chartType,
      title: sanitizePlainText(plan?.chart_spec?.title, 80, fallbackPlan.chart_spec.title),
      subtitle: sanitizePlainText(plan?.chart_spec?.subtitle, 120, fallbackSubtitle),
      takeaway: sanitizePlainText(plan?.chart_spec?.takeaway, 220, fallbackPlan.chart_spec.takeaway),
    },
  };
}

function allowedQuestionValue(allowed, key, value, fallback) {
  const list = allowed?.[key] || VISUAL_SYSTEM.app.supportedTimeScopes;
  return list.includes(value) ? value : fallback;
}

function sanitizePlainText(value, max, fallback = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return fallback;
  return text.slice(0, max);
}

function sanitizeListText(values, maxItems = 4, maxLen = 80) {
  if (!Array.isArray(values)) return [];
  return values
    .map((v) => sanitizePlainText(v, maxLen, ""))
    .filter(Boolean)
    .slice(0, maxItems);
}

async function maybeRefinePlanWithLLM(question, heuristicPlan, timeoutMs = 1300) {
  const parsed = await callOpenAIJson({
    systemPrompt: PHIA_QNA_CONFIG.planner.systemPrompt,
    userPayload: {
      question,
      heuristic_plan: heuristicPlan,
      allowed_question_types: VISUAL_SYSTEM.allowed.questionTypes,
      allowed_metrics: VISUAL_SYSTEM.allowed.metrics,
      allowed_time_scope: VISUAL_SYSTEM.app.supportedTimeScopes,
      allowed_comparison_mode: VISUAL_SYSTEM.allowed.comparisonModes,
      allowed_chart_types: VISUAL_SYSTEM.allowed.chartTypes,
    },
    model: PHIA_QNA_CONFIG.models.planner,
    maxTokens: PHIA_QNA_CONFIG.planner.maxTokens,
    temperature: PHIA_QNA_CONFIG.planner.temperature,
    timeoutMs,
  });

  if (!parsed || typeof parsed !== "object") return heuristicPlan;
  return normalizePlan(parsed, heuristicPlan);
}

async function fetchJsonWithTimeout(url, timeoutMs = 3000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs) || 3000));
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

  if (metricKey === "sleep_minutes") return `${base}/api/fitbit/${user}/sleep/range/date/${startDate}/${endDate}`;
  if (metricKey === "resting_hr") return `${base}/api/fitbit/${user}/heart/range/date/${startDate}/${endDate}`;
  if (metricKey === "calories") return `${base}/api/fitbit/${user}/activities/range/calories/date/${startDate}/${endDate}`;
  if (metricKey === "hrv") return `${base}/api/fitbit/${user}/hrv/range/date/${startDate}/${endDate}`;
  return `${base}/api/fitbit/${user}/activities/range/steps/date/${startDate}/${endDate}`;
}

function toMetricPoints(metricKey, rawPayload, windowDays) {
  if (metricKey === "sleep_minutes") return toSleepSeries(rawPayload, windowDays).sleep;
  return toMetricSeries(metricKey, rawPayload, windowDays);
}

function defaultFollowUps(metricKey) {
  if (metricKey === "sleep_minutes") {
    return [
      "Which night was my shortest sleep?",
      "How does this compare with last week?",
    ];
  }

  if (metricKey === "resting_hr") {
    return [
      "Which day had my lowest resting heart rate?",
      "How does this compare with last week?",
    ];
  }

  if (metricKey === "calories") {
    return [
      "Which day burned the most calories?",
      "How does this compare with last week?",
    ];
  }

  if (metricKey === "hrv") {
    return [
      "Which day had my highest HRV?",
      "How does this compare with last week?",
    ];
  }

  return [
    "Which day was my strongest day?",
    "How does this compare with last week?",
  ];
}

function buildBarOption({ labels, values, yAxisName, seriesName, palette, goalLine = null, highlightIndex = null }) {
  return {
    tooltip: { trigger: "axis" },
    xAxis: { type: "category", data: labels },
    yAxis: { type: "value", name: yAxisName },
    series: [
      {
        type: "bar",
        name: seriesName,
        data: values,
        itemStyle: {
          color: (params) => {
            if (Number.isFinite(highlightIndex) && params?.dataIndex === highlightIndex) {
              return palette.accent;
            }
            return palette.primary;
          },
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

function buildLineOption({ labels, values, yAxisName, seriesName, palette, goalLine = null }) {
  return {
    tooltip: { trigger: "axis" },
    xAxis: { type: "category", data: labels },
    yAxis: { type: "value", name: yAxisName },
    series: [
      {
        type: "line",
        name: seriesName,
        data: values,
        itemStyle: { color: palette.primary },
        lineStyle: { color: palette.primary, width: 3 },
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

function buildGroupedBarOption({ labels, series, yAxisName }) {
  return {
    tooltip: { trigger: "axis" },
    legend: { top: 8 },
    xAxis: { type: "category", data: labels },
    yAxis: { type: "value", name: yAxisName },
    series,
  };
}

function buildGaugeOption({ value, goal, name, palette }) {
  const max = Math.max(1, Number(goal) || 100);
  return {
    series: [
      {
        type: "gauge",
        max,
        progress: { show: true, width: 18, itemStyle: { color: palette.primary } },
        axisLine: { lineStyle: { width: 18, color: [[1, "#E2E8F0"]] } },
        pointer: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
        detail: {
          valueAnimation: false,
          formatter: ({ value: raw }) => `${Math.round(raw)}`,
          fontSize: 34,
          fontWeight: 700,
          color: palette.text,
        },
        title: { offsetCenter: [0, "76%"], fontSize: 14, color: "#475569" },
        data: [{ value: Math.max(0, Math.min(max, Number(value) || 0)), name }],
      },
    ],
  };
}

function buildPieOption({ values, labels }) {
  const data = labels.map((label, idx) => ({ name: label, value: Number(values[idx]) || 0 }));
  return {
    tooltip: { trigger: "item" },
    legend: { bottom: 0 },
    series: [
      {
        type: "pie",
        radius: ["42%", "72%"],
        data,
      },
    ],
  };
}

function buildSingleValueOption({ value, unit, takeaway }) {
  return {
    value,
    unit,
    graphic: [
      {
        type: "text",
        left: "center",
        top: "35%",
        style: {
          text: unit ? `${Math.round(value)} ${unit}` : `${Math.round(value)}`,
          fontSize: 44,
          fontWeight: 700,
          fill: "#0F172A",
        },
      },
      {
        type: "text",
        left: "center",
        top: "58%",
        style: {
          text: takeaway,
          fontSize: 16,
          fill: "#334155",
        },
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
          fontSize: 16,
          lineHeight: 28,
          fill: "#1E293B",
        },
      },
    ],
  };
}

function buildStatusOrPatternSpec({
  metricKey,
  points,
  plannerChartType,
  timeframeLabel,
  userContext,
}) {
  const palette = metricToPalette(metricKey);
  const unit = metricUnit(metricKey);
  const goal = metricKey === "steps"
    ? Number(userContext?.preferences?.dailyStepGoal || 10000)
    : metricKey === "sleep_minutes"
      ? Math.round((Number(userContext?.preferences?.sleepGoalMinutes || 480) / 60) * 10) / 10
      : null;

  const stats = calculateStats(points, goal);
  const highlight = pickHighlight(points);
  const labels = points.map((point) => point.label || point.fullLabel || point.date || "");
  const values = points.map((point) => Number(point.value) || 0);

  const useLine = plannerChartType === "line";
  const useGauge = plannerChartType === "gauge" && Number.isFinite(goal);
  const useSingleValue = plannerChartType === "single_value";
  const usePie = plannerChartType === "pie" && values.length <= 10;

  let option = null;
  let chartType = plannerChartType;

  if (useGauge) {
    chartType = "gauge";
    option = buildGaugeOption({
      value: stats.current,
      goal,
      name: `${toTitleCase(metricLabel(metricKey))} today`,
      palette,
    });
  } else if (useSingleValue) {
    chartType = "single_value";
    option = buildSingleValueOption({
      value: stats.current,
      unit,
      takeaway: `Latest ${metricLabel(metricKey)} value`,
    });
  } else if (usePie) {
    chartType = "pie";
    option = buildPieOption({ values, labels });
  } else if (useLine) {
    chartType = "line";
    option = buildLineOption({
      labels,
      values,
      yAxisName: unit,
      seriesName: toTitleCase(metricLabel(metricKey)),
      palette,
      goalLine: Number.isFinite(goal) ? goal : null,
    });
  } else {
    chartType = "bar";
    option = buildBarOption({
      labels,
      values,
      yAxisName: unit,
      seriesName: toTitleCase(metricLabel(metricKey)),
      palette,
      goalLine: Number.isFinite(goal) ? goal : null,
      highlightIndex: highlight ? points.findIndex((point) => point.date === highlight.date) : null,
    });
  }

  const trendText = Math.abs(stats.wowChangePct) < 5
    ? "is mostly steady"
    : stats.wowChangePct > 0
      ? `is ${Math.abs(stats.wowChangePct)}% higher than the previous period`
      : `is ${Math.abs(stats.wowChangePct)}% lower than the previous period`;

  const takeaway = `Average ${metricLabel(metricKey)} was ${formatMetricValue(stats.avg, unit)} over the ${timeframeLabel} and ${trendText}.`;
  const voice = `${toTitleCase(metricLabel(metricKey))} averaged ${formatMetricValue(stats.avg, unit)} over the ${timeframeLabel}.`;

  return {
    chart_spec: {
      chart_type: chartType,
      title: `${toTitleCase(metricLabel(metricKey))} - ${timeframeLabel}`,
      subtitle: timeframeLabel,
      takeaway,
      highlight: highlight
        ? {
            label: highlight.label,
            value: Number(highlight.value) || undefined,
            reason: highlight.reason || undefined,
          }
        : null,
      option,
    },
    stats,
    voice_answer: voice,
  };
}

function buildComparisonSpec({ metricKey, points, baseDays, timeframeLabel }) {
  const palette = metricToPalette(metricKey);
  const unit = metricUnit(metricKey);
  const compared = comparePeriods(points, baseDays);

  const previousLabel = `Previous ${timeframeLabel}`;
  const currentLabel = `Current ${timeframeLabel}`;

  const option = buildGroupedBarOption({
    labels: ["Average"],
    yAxisName: unit,
    series: [
      {
        type: "bar",
        name: previousLabel,
        data: [Number(compared.previousAvg) || 0],
        itemStyle: { color: palette.secondary },
      },
      {
        type: "bar",
        name: currentLabel,
        data: [Number(compared.currentAvg) || 0],
        itemStyle: { color: palette.primary },
      },
    ],
  });

  const direction = compared.direction === "up"
    ? "higher"
    : compared.direction === "down"
      ? "lower"
      : "about the same";

  const takeaway = `${toTitleCase(metricLabel(metricKey))} is ${direction} compared with the previous period.`;
  const voice = `${toTitleCase(metricLabel(metricKey))} is ${direction} versus the previous period.`;

  return {
    chart_spec: {
      chart_type: "grouped_bar",
      title: `${toTitleCase(metricLabel(metricKey))} comparison`,
      subtitle: `${timeframeLabel} vs previous`,
      takeaway,
      highlight: {
        label: currentLabel,
        value: Number(compared.currentAvg) || 0,
        reason: compared.direction,
      },
      option,
    },
    stats: {
      previousAvg: compared.previousAvg,
      currentAvg: compared.currentAvg,
      changePct: compared.changePct,
      direction: compared.direction,
    },
    voice_answer: voice,
  };
}

function buildRelationshipSpec({
  primaryMetricKey,
  secondaryMetricKey,
  primaryPoints,
  secondaryPoints,
  timeframeLabel,
}) {
  const shiftSecondaryByDays = primaryMetricKey === "sleep_minutes" && secondaryMetricKey !== "sleep_minutes" ? 1 : 0;
  const relationship = describeRelationship(primaryPoints, secondaryPoints, { shiftSecondaryByDays });

  if (!Array.isArray(relationship.grouped) || !relationship.grouped.length) {
    const fallback = {
      chart_spec: {
        chart_type: "list_summary",
        title: "Relationship check",
        subtitle: timeframeLabel,
        takeaway: relationship.statement || "Not enough data for a reliable comparison yet.",
        option: buildListSummaryOption([
          "I could not find enough overlapping days yet.",
          "Try again after a few more days of tracking.",
        ]),
      },
      stats: null,
      voice_answer: relationship.statement || "I need more data before I can compare those patterns.",
    };
    return fallback;
  }

  const unit = metricUnit(secondaryMetricKey);
  const palette = metricToPalette("relationship");

  const labels = relationship.grouped.map((item) => item.label);
  const values = relationship.grouped.map((item) => Number(item.value) || 0);

  const option = buildBarOption({
    labels,
    values,
    yAxisName: unit,
    seriesName: toTitleCase(metricLabel(secondaryMetricKey)),
    palette,
  });

  const takeaway = relationship.statement.replace("sleep", metricLabel(primaryMetricKey));

  return {
    chart_spec: {
      chart_type: "bar",
      title: `${toTitleCase(metricLabel(secondaryMetricKey))} on higher vs lower ${metricLabel(primaryMetricKey)} days`,
      subtitle: timeframeLabel,
      takeaway,
      highlight: {
        label: relationship.effectDirection === "higher" ? labels[0] : labels[1],
        reason: relationship.effectDirection,
      },
      option,
    },
    stats: relationship,
    voice_answer: takeaway,
  };
}

function buildReminderLikePayload(question, plannerPlan) {
  const list = [
    "Use the reminder workflow to create or edit medication reminders.",
    "This QnA page focuses on Fitbit trends and short chart summaries.",
    "Ask about sleep, steps, heart rate, calories, or HRV for a chart response.",
  ];

  const rawChartSpec = {
    chart_type: "list_summary",
    title: "Reminder help",
    subtitle: "Quick guidance",
    takeaway: "Reminder setup lives in the reminder flow.",
    option: buildListSummaryOption(list),
    suggested_follow_up: ["What is my next medication reminder?"],
  };

  const chartSpec = validateChartSpec(rawChartSpec, "Reminder help");
  const voiceAnswer = compressAlexaSpeech(
    plannerPlan?.voice_answer || "Reminder setup is in the reminder workflow. I can still summarize your Fitbit trends here."
  );

  return {
    payload: {
      question,
      question_type: "reminder",
      metrics_needed: [],
      time_scope: VISUAL_SYSTEM.app.defaultTimeScope,
      comparison_mode: "none",
      voice_answer: voiceAnswer,
      suggested_follow_up: ["What is my next medication reminder?"],
      chart_spec: {
        ...chartSpec,
        suggested_follow_up: ["What is my next medication reminder?"],
      },
      stages: [
        {
          id: "stage_1",
          cue: "Reminder help",
          voice_answer: voiceAnswer,
          suggested_follow_up: ["What is my next medication reminder?"],
          chart_spec: {
            ...chartSpec,
            suggested_follow_up: ["What is my next medication reminder?"],
          },
        },
      ],
      activeStageIndex: 0,
      chart_context: {
        question_type: "reminder",
        metrics_needed: [],
        time_scope: VISUAL_SYSTEM.app.defaultTimeScope,
        comparison_mode: "none",
      },
    },
    rawData: null,
    userContext: null,
    planner: plannerPlan || null,
  };
}

function pickPlannerFollowUps(planFollowUps, metricKey) {
  const fromPlanner = sanitizeListText(planFollowUps, 4, 80);
  return fromPlanner.length ? fromPlanner : defaultFollowUps(metricKey);
}

/**
 * Builds one QnA payload with deterministic chart_spec output.
 */
async function buildQnaPayload({
  username,
  question,
  userContext = null,
  allowPlannerLLM = false,
  fetchTimeoutMs = 2800,
}) {
  const q = sanitizePlainText(question, 280, "");
  const u = sanitizePlainText(username, 60, "amy").toLowerCase();
  const ctx = userContext || (await getUserContext(u)) || null;

  const heuristicPlan = inferHeuristicPlan(q);
  const planner = allowPlannerLLM
    ? await maybeRefinePlanWithLLM(q, heuristicPlan)
    : heuristicPlan;

  if (planner.question_type === "reminder" || planner.question_type === "coaching" || planner.question_type === "unsupported") {
    return buildReminderLikePayload(q, planner);
  }

  const primaryMetricKey = planner.metrics_needed?.[0] || "steps";
  const secondaryMetricKey = planner.metrics_needed?.[1] || null;
  const needsComparisonWindow = planner.comparison_mode === "previous_period";

  const window = computeDateWindow(planner.time_scope, needsComparisonWindow ? 2 : 1);

  const primaryRaw = await fetchJsonWithTimeout(
    buildFitbitInternalUrl({
      username: u,
      metricKey: primaryMetricKey,
      startDate: window.startDate,
      endDate: window.endDate,
    }),
    fetchTimeoutMs
  );

  const primaryPointsAll = toMetricPoints(primaryMetricKey, primaryRaw, window.windowDays);
  const primaryPointsCurrent = sliceLast(primaryPointsAll, window.baseDays);

  let secondaryRaw = null;
  let secondaryPointsAll = null;
  let secondaryPointsCurrent = null;

  if (secondaryMetricKey) {
    secondaryRaw = await fetchJsonWithTimeout(
      buildFitbitInternalUrl({
        username: u,
        metricKey: secondaryMetricKey,
        startDate: window.startDate,
        endDate: window.endDate,
      }),
      fetchTimeoutMs
    );

    secondaryPointsAll = toMetricPoints(secondaryMetricKey, secondaryRaw, window.windowDays);
    secondaryPointsCurrent = sliceLast(secondaryPointsAll, window.baseDays);
  }

  let built;
  if (planner.question_type === "comparison" || planner.comparison_mode === "previous_period") {
    built = buildComparisonSpec({
      metricKey: primaryMetricKey,
      points: primaryPointsAll,
      baseDays: window.baseDays,
      timeframeLabel: window.timeframeLabel,
    });
  } else if (planner.question_type === "relationship" && secondaryPointsCurrent?.length) {
    built = buildRelationshipSpec({
      primaryMetricKey,
      secondaryMetricKey,
      primaryPoints: primaryPointsCurrent,
      secondaryPoints: secondaryPointsCurrent,
      timeframeLabel: window.timeframeLabel,
    });
  } else {
    built = buildStatusOrPatternSpec({
      metricKey: primaryMetricKey,
      points: primaryPointsCurrent,
      plannerChartType: planner.chart_spec.chart_type,
      timeframeLabel: window.timeframeLabel,
      userContext: ctx,
    });
  }

  const mergedRawSpec = {
    chart_type: built?.chart_spec?.chart_type || planner.chart_spec.chart_type,
    title: built?.chart_spec?.title || planner.chart_spec.title,
    subtitle: built?.chart_spec?.subtitle || planner.chart_spec.subtitle,
    takeaway: built?.chart_spec?.takeaway || planner.chart_spec.takeaway,
    highlight: built?.chart_spec?.highlight || null,
    suggested_follow_up: pickPlannerFollowUps(planner.suggested_follow_up, primaryMetricKey),
    option: built?.chart_spec?.option,
  };

  const validatedChartSpec = validateChartSpec(mergedRawSpec, mergedRawSpec.title || "Your Health Data");

  const deterministicVoice = built?.voice_answer || "I prepared your chart.";
  const voiceAnswer = compressAlexaSpeech(
    sanitizePlainText(planner.voice_answer, 180, deterministicVoice) || deterministicVoice,
    "Here is your quick summary."
  );

  const suggestedFollowUp = validatedChartSpec.suggested_follow_up?.length
    ? validatedChartSpec.suggested_follow_up
    : pickPlannerFollowUps(planner.suggested_follow_up, primaryMetricKey);

  const fallbackSafeSpec = validatedChartSpec?.option
    ? validatedChartSpec
    : buildFallbackChartSpec("Your Health Data", "I could not prepare that chart safely.");

  const payload = {
    question: q,
    question_type: planner.question_type,
    metrics_needed: planner.metrics_needed,
    time_scope: planner.time_scope,
    comparison_mode: planner.comparison_mode,
    voice_answer: voiceAnswer,
    suggested_follow_up: suggestedFollowUp,
    chart_spec: {
      ...fallbackSafeSpec,
      suggested_follow_up: suggestedFollowUp,
    },
    stages: [
      {
        id: "stage_1",
        cue: fallbackSafeSpec.title,
        voice_answer: voiceAnswer,
        suggested_follow_up: suggestedFollowUp,
        chart_spec: {
          ...fallbackSafeSpec,
          suggested_follow_up: suggestedFollowUp,
        },
      },
    ],
    activeStageIndex: 0,
    chart_context: {
      question_type: planner.question_type,
      metrics_needed: planner.metrics_needed,
      time_scope: planner.time_scope,
      comparison_mode: planner.comparison_mode,
      primary_metric: primaryMetricKey,
      secondary_metric: secondaryMetricKey,
      summary_stats: built?.stats || null,
      updated_at: Date.now(),
    },
  };

  return {
    payload,
    rawData: {
      primaryRaw,
      secondaryRaw,
    },
    userContext: ctx,
    planner,
  };
}

module.exports = {
  buildQnaPayload,
  getUserContext,
  inferHeuristicPlan,
  maybeRefinePlanWithLLM,
};
