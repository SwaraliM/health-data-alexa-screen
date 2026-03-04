const express = require("express");
const { SERVER_ERROR } = require("../../utils/constants");
const { calculateStats, detectAnomalies } = require("../services/chartInsightService");
const { buildChartSpec } = require("../services/chartSpecService");
const { toSeriesFromResource, toSleepSeries, composeChartPayload } = require("../services/chartDataService");
const User = require("../models/Users");

const aiRouter = express.Router();

// In-memory cache for question -> chart responses (per user/metric/range)
const qnaChartCache = new Map();
const QNA_CHART_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const getCacheKey = (username, metricKey, timeRange, aggregation) =>
  `${String(username || "").toLowerCase()}::${metricKey}::${timeRange}::${aggregation}`;

const getCachedChartPayload = (cacheKey) => {
  const entry = qnaChartCache.get(cacheKey);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > QNA_CHART_CACHE_TTL_MS) {
    qnaChartCache.delete(cacheKey);
    return null;
  }
  return entry.payload;
};

const setCachedChartPayload = (cacheKey, payload) => {
  qnaChartCache.set(cacheKey, { timestamp: Date.now(), payload });
};

function calculateSimpleTrend(points = []) {
  const values = points.map((point) => Number(point?.value)).filter((value) => Number.isFinite(value));
  if (values.length < 2) return { direction: "stable", changePct: 0, avg: values[0] || 0 };

  const first = values[0] || 0;
  const last = values[values.length - 1] || 0;
  const avg = Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
  const changePct = first === 0 ? 0 : Math.round(((last - first) / Math.abs(first)) * 100);

  let direction = "stable";
  if (changePct > 8) direction = "up";
  if (changePct < -8) direction = "down";

  return { direction, changePct, avg };
}

function buildFallbackAnswer(metricType, timeframe, points, userQuestion = "") {
  const trend = calculateSimpleTrend(points);
  const metricLabel = String(metricType || "metric");
  const periodLabel = String(timeframe || "week");
  const questionText = String(userQuestion || "").trim();

  const trendSentence = trend.direction === "up"
    ? `${metricLabel} is trending up (${Math.abs(trend.changePct)}% change).`
    : trend.direction === "down"
      ? `${metricLabel} is trending down (${Math.abs(trend.changePct)}% change).`
      : `${metricLabel} is mostly steady.`;

  return {
    answer: `${trendSentence} Average over this ${periodLabel} is ${trend.avg}. ${questionText ? `For your question: ${questionText}` : ""}`.trim(),
    confidence: points.length >= 7 ? "Medium" : "Low",
    notes: "Generated from local trend analysis.",
  };
}

const askOpenAIJson = async (systemPrompt, userPayload, maxTokens = 320) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: process.env.OPENAI_TRENDS_MODEL || "gpt-4o-mini",
      temperature: 0.2,
      max_completion_tokens: maxTokens,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(userPayload) },
      ],
    }),
  });

  if (!response.ok) return null;
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch (error) {
    return null;
  }
};

// Basic heuristic mapping from free-form question to metric + range
function inferQnaIntentFromQuestion(question = "", userContext = null) {
  const q = String(question || "").toLowerCase();

  let metricKey = "steps";
  if (/\bsleep|rest(ed)?\b/.test(q)) metricKey = "sleep_minutes";
  else if (/\bhrv\b|\bvariability\b/.test(q)) metricKey = "hrv";
  else if (/\bheart\b|\bpulse\b|\bresting\b/.test(q)) metricKey = "resting_hr";
  else if (/\bcalorie|calories|energy burn|burned\b/.test(q)) metricKey = "calories";

  let timeRange = "last_7_days";
  if (/\bmonth\b|\b30\b/.test(q)) timeRange = "last_30_days";

  let aggregation = "daily";
  if (/\bweekly\b|\bper week\b/.test(q)) aggregation = "weekly";

  let chartType = "line";
  if (metricKey === "sleep_minutes") chartType = "bar";
  if (metricKey === "calories" && aggregation === "weekly") chartType = "stacked_bar";

  return {
    metricKeys: [metricKey],
    timeRange,
    aggregation,
    chartType,
  };
}

async function getQnaIntentFromGPT(question, heuristicIntent) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const systemPrompt = [
    "You map older adults' health questions to chart intents for a tablet dashboard.",
    "Return compact JSON with keys: metricKeys, timeRange, aggregation, chartType.",
    "metricKeys: array of strings chosen from: steps, sleep_minutes, resting_hr, hrv, calories.",
    "timeRange: one of last_7_days, last_30_days.",
    "aggregation: one of daily, weekly.",
    "chartType: one of line, bar, stacked_bar.",
    "If unsure, fall back to sensible defaults and the provided heuristicIntent.",
  ].join(" ");

  const parsed = await askOpenAIJson(systemPrompt, {
    question,
    heuristicIntent,
  }, 260);

  if (!parsed || typeof parsed !== "object") return null;

  const metricKeys = Array.isArray(parsed.metricKeys) && parsed.metricKeys.length
    ? parsed.metricKeys.filter((m) =>
        ["steps", "sleep_minutes", "resting_hr", "hrv", "calories"].includes(String(m))
      )
    : heuristicIntent.metricKeys;

  const timeRange = ["last_7_days", "last_30_days"].includes(parsed.timeRange)
    ? parsed.timeRange
    : heuristicIntent.timeRange;

  const aggregation = ["daily", "weekly"].includes(parsed.aggregation)
    ? parsed.aggregation
    : heuristicIntent.aggregation;

  const chartType = ["line", "bar", "stacked_bar"].includes(parsed.chartType)
    ? parsed.chartType
    : heuristicIntent.chartType;

  return {
    metricKeys: metricKeys.length ? metricKeys : heuristicIntent.metricKeys,
    timeRange,
    aggregation,
    chartType,
  };
}

const asDateLabel = (dateStr) => {
  if (!dateStr) return "";
  const date = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(date.getTime())) return String(dateStr);
  return ["S", "M", "T", "W", "Th", "F", "S"][date.getDay()];
};

const formatDate = (date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

function computeDateWindow(timeRange) {
  const days = timeRange === "last_30_days" ? 30 : 7;
  const end = new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - (days - 1));
  return {
    windowDays: days,
    startDate: formatDate(start),
    endDate: formatDate(end),
    timeframeLabel: timeRange === "last_30_days" ? "last 30 days" : "last 7 days",
  };
}

function buildLocalExplanation(metricType, timeframeLabel, stats, goal, unit) {
  if (!stats || typeof stats !== "object") {
    return "I could not find enough data to show a clear pattern.";
  }
  const baseLabel = (() => {
    if (metricType === "sleep") return "sleep";
    if (metricType === "heart") return "resting heart rate";
    if (metricType === "hrv") return "heart rate variability";
    if (metricType === "calories") return "calories";
    return "steps";
  })();

  const avgSentence = `Over the ${timeframeLabel}, your ${baseLabel} averaged ${stats.avg.toLocaleString()}${unit ? ` ${unit}` : ""}.`;
  const rangeSentence = `Your highest value was ${stats.high.toLocaleString()} and your lowest was ${stats.low.toLocaleString()}${unit ? ` ${unit}` : ""}.`;
  const goalSentence = Number.isFinite(Number(goal))
    ? `Compared with your goal of ${Number(goal).toLocaleString()}${unit ? ` ${unit}` : ""}, you're doing ${stats.wowChangePct >= 0 ? "slightly better" : "a bit below"} on recent days.`
    : "";

  return [avgSentence, rangeSentence, goalSentence].filter(Boolean).join(" ");
}

async function buildExplanationForChart(metricType, timeframeLabel, chartData, question) {
  const stats = chartData?.stats || calculateStats(chartData?.series || []);
  const anomalies = Array.isArray(chartData?.anomalies) ? chartData.anomalies : [];
  const unit = chartData?.unit || "";
  const goal = stats?.goal ?? null;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      explanation: buildLocalExplanation(metricType, timeframeLabel, stats, goal, unit),
      suggestedQuestion: "How does this compare to last month?",
    };
  }

  const systemPrompt = [
    "You explain health charts for older adults on a tablet.",
    "Return compact JSON with keys: explanation, suggestedQuestion.",
    "explanation: 2-5 short sentences that directly interpret the chart (trend, highs/lows, anomalies, timeframe) in simple language.",
    "suggestedQuestion: one short follow-up question they could ask next.",
    "Do not give medical advice; focus on what the numbers show.",
  ].join(" ");

  const parsed = await askOpenAIJson(
    systemPrompt,
    {
      metricType,
      timeframeLabel,
      stats,
      anomalies,
      sampleSeries: (chartData?.series || []).slice(-12),
      userQuestion: question,
      unit,
    },
    420
  );

  const fallbackExplanation = buildLocalExplanation(metricType, timeframeLabel, stats, goal, unit);

  if (!parsed || typeof parsed !== "object") {
    return {
      explanation: fallbackExplanation,
      suggestedQuestion: "How does this compare to last month?",
    };
  }

  const explanation = typeof parsed.explanation === "string" && parsed.explanation.trim()
    ? parsed.explanation.trim()
    : fallbackExplanation;

  const suggestedQuestion = Array.isArray(parsed.suggestedQuestions) && parsed.suggestedQuestions.length
    ? String(parsed.suggestedQuestions[0])
    : (typeof parsed.suggestedQuestion === "string" && parsed.suggestedQuestion.trim()
        ? parsed.suggestedQuestion.trim()
        : "How does this compare to last month?");

  return { explanation, suggestedQuestion };
}

async function buildChartForIntent(username, metricKey, timeRange, aggregation, chartType, userContext, question) {
  const { windowDays, startDate, endDate, timeframeLabel } = computeDateWindow(timeRange);
  const internalApiUrl = process.env.INTERNAL_API_URL || "http://localhost:5001";
  const lcMetric = metricKey === "steps_count" ? "steps" : metricKey;

  let metricType = "steps";
  let unit = "";
  let chartPayload = null;

  if (lcMetric === "sleep_minutes") {
    // Sleep minutes -> hours bar chart from sleep range endpoint
    const url = `${internalApiUrl}/api/fitbit/${username}/sleep/range/date/${startDate}/${endDate}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`Fitbit sleep fetch failed with status ${resp.status}`);
    }
    const json = await resp.json();
    const sleepSeries = toSleepSeries(json, windowDays);
    const points = Array.isArray(sleepSeries?.sleep) ? sleepSeries.sleep : [];
    if (!points.length) {
      return {
        chartSpec: null,
        chartData: { series: [], stats: { avg: 0, high: 0, low: 0, goal: null, wowChangePct: 0 }, anomalies: [], unit: "hours" },
        explanation: "I could not find enough recent sleep data to draw a chart.",
        suggestedQuestion: "Can you show my recent steps instead?",
      };
    }
    const sleepGoalMinutes = Number(userContext?.preferences?.sleepGoalMinutes || 480);
    const sleepGoalHours = Number.isFinite(sleepGoalMinutes) ? Math.round((sleepGoalMinutes / 60) * 10) / 10 : null;
    metricType = "sleep";
    unit = "hours";
    chartPayload = composeChartPayload({
      metricType,
      timeframe: timeRange,
      points,
      goal: sleepGoalHours,
      unit,
    });
  } else if (lcMetric === "resting_hr") {
    // Resting heart rate trend from heart period endpoint
    const period = windowDays === 30 ? "30d" : "7d";
    const url = `${internalApiUrl}/api/fitbit/${username}/heart/period/date/today/${period}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`Fitbit heart fetch failed with status ${resp.status}`);
    }
    const json = await resp.json();
    const heartRaw = Array.isArray(json["activities-heart"]) ? json["activities-heart"].slice(-windowDays) : [];
    const points = heartRaw
      .map((entry, idx) => {
        const date = String(entry?.dateTime || "");
        const v = Number(entry?.value?.restingHeartRate ?? entry?.value ?? NaN);
        if (!date || !Number.isFinite(v)) return null;
        return {
          date,
          label: asDateLabel(date) || String(idx + 1),
          value: v,
        };
      })
      .filter(Boolean);

    if (!points.length) {
      return {
        chartSpec: null,
        chartData: { series: [], stats: { avg: 0, high: 0, low: 0, goal: null, wowChangePct: 0 }, anomalies: [], unit: "bpm" },
        explanation: "I could not find enough recent heart rate data to draw a chart.",
        suggestedQuestion: "Can you show my recent steps instead?",
      };
    }

    metricType = "heart";
    unit = "bpm";
    const stats = calculateStats(points);
    const anomalies = detectAnomalies(points);
    const baseSpec = buildChartSpec({ metricType, goal: null, anomalies });
    chartPayload = {
      metricType,
      timeframe: timeRange,
      unit,
      points,
      goal: null,
      stats,
      chartSpec: baseSpec,
      anomalies,
    };
  } else if (lcMetric === "calories") {
    // Calories trend from activities period calories endpoint
    const period = windowDays === 30 ? "30d" : "7d";
    const url = `${internalApiUrl}/api/fitbit/${username}/activities/period/calories/date/today/${period}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`Fitbit calories fetch failed with status ${resp.status}`);
    }
    const json = await resp.json();
    const points = toSeriesFromResource(json, "activities-calories", windowDays);
    if (!points.length) {
      return {
        chartSpec: null,
        chartData: { series: [], stats: { avg: 0, high: 0, low: 0, goal: null, wowChangePct: 0 }, anomalies: [], unit: "calories" },
        explanation: "I could not find enough recent calorie data to draw a chart.",
        suggestedQuestion: "Can you show my recent steps instead?",
      };
    }
    metricType = "calories";
    unit = "calories";
    chartPayload = composeChartPayload({
      metricType,
      timeframe: timeRange,
      points,
      goal: null,
      unit,
    });
  } else {
    // Default: steps trend from activities period steps endpoint
    const period = windowDays === 30 ? "30d" : "7d";
    const url = `${internalApiUrl}/api/fitbit/${username}/activities/period/steps/date/today/${period}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`Fitbit steps fetch failed with status ${resp.status}`);
    }
    const json = await resp.json();
    const points = toSeriesFromResource(json, "activities-steps", windowDays);
    if (!points.length) {
      return {
        chartSpec: null,
        chartData: { series: [], stats: { avg: 0, high: 0, low: 0, goal: null, wowChangePct: 0 }, anomalies: [], unit: "steps" },
        explanation: "I could not find enough recent step data to draw a chart.",
        suggestedQuestion: "Can you show my sleep instead?",
      };
    }
    metricType = "steps";
    unit = "steps";
    const stepGoal = Number(userContext?.preferences?.dailyStepGoal || 10000);
    chartPayload = composeChartPayload({
      metricType,
      timeframe: timeRange,
      points,
      goal: Number.isFinite(stepGoal) ? stepGoal : null,
      unit,
    });
  }

  const chartData = {
    series: chartPayload.points,
    stats: chartPayload.stats,
    anomalies: chartPayload.anomalies || [],
    unit,
  };

  const chosenType = chartType || chartPayload.chartSpec?.type || (metricType === "sleep" ? "bar" : "line");
  const chartSpec = {
    metricKeys: [metricKey],
    timeRange,
    aggregation,
    chartType: chosenType,
    title:
      metricType === "sleep"
        ? `Sleep - ${timeframeLabel}`
        : metricType === "heart"
          ? `Resting Heart Rate - ${timeframeLabel}`
          : metricType === "calories"
            ? `Calories - ${timeframeLabel}`
            : `Steps - ${timeframeLabel}`,
    yAxisLabel:
      metricType === "sleep"
        ? "Hours"
        : metricType === "heart"
          ? "Beats per minute"
          : metricType === "calories"
            ? "Calories"
            : "Steps",
    showGoalLine: Boolean(chartPayload.chartSpec?.showGoalLine),
    goalLineValue: chartPayload.chartSpec?.goalLineValue ?? null,
    series: chartData.series,
    annotations: Array.isArray(chartPayload.anomalies) ? chartPayload.anomalies : [],
  };

  const { explanation, suggestedQuestion } = await buildExplanationForChart(
    metricType,
    timeframeLabel,
    chartData,
    question
  );

  return {
    chartSpec,
    chartData,
    explanation,
    suggestedQuestion,
  };
}

// New unified Question -> ChartSpec/ChartData/Explanation endpoint
aiRouter.post("/qna-ask", async (req, res) => {
  const username = String(req.body?.username || "amy").trim().toLowerCase();
  const question = String(req.body?.question || "").trim();

  if (!question) {
    return res.status(400).json({ error: "question is required" });
  }

  let userContext = null;
  try {
    const user = await User.findOne({ username });
    if (user) {
      userContext = {
        age: user?.userProfile?.age || null,
        gender: user?.userProfile?.gender || "unknown",
        fitnessLevel: user?.userProfile?.fitnessLevel || "moderately_active",
        healthGoals: user?.userProfile?.healthGoals || [],
        healthConditions: user?.userProfile?.healthConditions || [],
        preferences: {
          preferredExercise: user?.userProfile?.preferences?.preferredExercise || [],
          sleepGoalMinutes: user?.userProfile?.preferences?.sleepGoalMinutes || 480,
          dailyStepGoal: user?.userProfile?.preferences?.dailyStepGoal || 10000,
          dailyCalorieGoal: user?.userProfile?.preferences?.dailyCalorieGoal || null,
        },
      };
    }
  } catch (err) {
    // Non-fatal: continue without user context
    console.error("qna-ask: user lookup failed:", err.message);
  }

  const heuristicIntent = inferQnaIntentFromQuestion(question, userContext);
  let intent = heuristicIntent;

  try {
    const gptIntent = await getQnaIntentFromGPT(question, heuristicIntent);
    if (gptIntent) intent = gptIntent;
  } catch (err) {
    console.error("qna-ask: intent GPT error:", err.message);
  }

  const metricKeys = Array.isArray(intent.metricKeys) && intent.metricKeys.length
    ? intent.metricKeys
    : heuristicIntent.metricKeys;
  const primaryMetricKey = metricKeys[0];
  const timeRange = intent.timeRange || heuristicIntent.timeRange;
  const aggregation = intent.aggregation || heuristicIntent.aggregation;
  const chartType = intent.chartType || heuristicIntent.chartType;

  const cacheKey = getCacheKey(username, primaryMetricKey, timeRange, aggregation);
  const cached = getCachedChartPayload(cacheKey);
  if (cached) {
    return res.status(200).json({ ...cached, _cache: true });
  }

  try {
    const built = await buildChartForIntent(
      username,
      primaryMetricKey,
      timeRange,
      aggregation,
      chartType,
      userContext,
      question
    );

    const payload = {
      chartSpec: built.chartSpec,
      chartData: built.chartData,
      explanation: built.explanation,
      suggestedQuestion: built.suggestedQuestion,
    };

    setCachedChartPayload(cacheKey, payload);

    return res.status(200).json(payload);
  } catch (error) {
    console.error("qna-ask error:", error.message);
    return res.status(500).json({
      error: SERVER_ERROR,
      details: "I had trouble preparing that chart. Please try a simpler question.",
    });
  }
});

aiRouter.post("/trends-explain", async (req, res) => {
  const {
    metricType = "steps",
    timeframe = "week",
    aggregatedDataPoints = [],
    userQuestion = "What stands out?",
  } = req.body || {};

  if (!Array.isArray(aggregatedDataPoints) || aggregatedDataPoints.length === 0) {
    return res.status(400).json({
      answer: "I need more trend data to answer that.",
      confidence: "Low",
      notes: "No aggregated points were provided.",
    });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(200).json(buildFallbackAnswer(metricType, timeframe, aggregatedDataPoints, userQuestion));
  }

  const systemPrompt = [
    "You explain health trends for older adults on a smart screen.",
    "Return compact JSON with keys: answer, confidence, notes.",
    "answer must be <= 2 short sentences.",
    "confidence must be one of: Low, Medium, High.",
    "notes must be <= 1 short sentence and mention uncertainty when data is sparse.",
  ].join(" ");

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: process.env.OPENAI_TRENDS_MODEL || "gpt-4o-mini",
        temperature: 0.2,
        max_completion_tokens: 220,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: JSON.stringify({ metricType, timeframe, aggregatedDataPoints, userQuestion }),
          },
        ],
      }),
    });

    if (!response.ok) {
      const fallback = buildFallbackAnswer(metricType, timeframe, aggregatedDataPoints, userQuestion);
      return res.status(200).json(fallback);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      const fallback = buildFallbackAnswer(metricType, timeframe, aggregatedDataPoints, userQuestion);
      return res.status(200).json(fallback);
    }

    let parsed = null;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      parsed = buildFallbackAnswer(metricType, timeframe, aggregatedDataPoints, userQuestion);
    }

    return res.status(200).json({
      answer: parsed?.answer || "I can explain this trend after more data is available.",
      confidence: ["Low", "Medium", "High"].includes(parsed?.confidence) ? parsed.confidence : "Medium",
      notes: parsed?.notes || "Based on your selected trend data.",
    });
  } catch (error) {
    return res.status(500).json({ error: SERVER_ERROR, details: error.message });
  }
});

aiRouter.post("/chart/enrich", async (req, res) => {
  const {
    metricType = "steps",
    timeframe = "week",
    series = [],
    stats = null,
    goal = null,
    context = {},
    uiContext = {},
  } = req.body || {};

  if (!Array.isArray(series) || series.length === 0) {
    return res.status(400).json({
      chartTitle: "No data",
      chartSummary: "No data was provided for this chart.",
      voiceExplanation: "There is not enough data to explain this chart.",
      explanationBullets: ["No points provided.", "Sync Fitbit and try again.", "Select another timeframe."],
      anomalies: [],
      suggestedQuestions: [],
      drilldownHints: [],
      confidence: "Low",
    });
  }

  const deterministicStats = stats && typeof stats === "object" ? stats : calculateStats(series, goal);
  const deterministicAnomalies = detectAnomalies(series);
  const deterministicSpec = buildChartSpec({ metricType, goal, anomalies: deterministicAnomalies });

  const fallback = {
    chartTitle: `${String(metricType).charAt(0).toUpperCase()}${String(metricType).slice(1)} Trend`,
    chartSummary: `${metricType} average is ${deterministicStats.avg} this ${timeframe}.`,
    voiceExplanation: `This chart shows your ${metricType} trend for the selected ${timeframe}.`,
    explanationBullets: [
      `Average: ${deterministicStats.avg}`,
      `High: ${deterministicStats.high}, Low: ${deterministicStats.low}`,
      deterministicStats.wowChangePct >= 0 ? `Up ${Math.abs(deterministicStats.wowChangePct)}% vs previous period` : `Down ${Math.abs(deterministicStats.wowChangePct)}% vs previous period`,
    ],
    anomalies: deterministicAnomalies,
    suggestedQuestions: [
      "What caused the biggest drop?",
      "How can I improve tomorrow?",
      "Am I close to my goal?",
    ],
    drilldownHints: [
      "Tap a point to explain that day.",
      "Select a range to compare periods.",
    ],
    chartSpec: deterministicSpec,
    confidence: series.length >= 7 ? "Medium" : "Low",
  };

  try {
    const parsed = await askOpenAIJson(
      [
        "You enrich health trend charts for older adults.",
        "Return compact JSON with keys:",
        "chartTitle, chartSummary, voiceExplanation, explanationBullets, suggestedQuestions, drilldownHints, confidence.",
        "chartSummary and voiceExplanation should be <= 2 short sentences.",
        "explanationBullets max 3 items.",
        "confidence one of Low/Medium/High.",
      ].join(" "),
      { metricType, timeframe, series, stats: deterministicStats, goal, context, uiContext },
      360
    );

    return res.status(200).json({
      chartTitle: parsed?.chartTitle || fallback.chartTitle,
      chartSummary: parsed?.chartSummary || fallback.chartSummary,
      voiceExplanation: parsed?.voiceExplanation || fallback.voiceExplanation,
      explanationBullets: Array.isArray(parsed?.explanationBullets) && parsed.explanationBullets.length > 0
        ? parsed.explanationBullets.slice(0, 3)
        : fallback.explanationBullets,
      anomalies: fallback.anomalies,
      suggestedQuestions: Array.isArray(parsed?.suggestedQuestions) && parsed.suggestedQuestions.length > 0
        ? parsed.suggestedQuestions.slice(0, 4)
        : fallback.suggestedQuestions,
      drilldownHints: Array.isArray(parsed?.drilldownHints) && parsed.drilldownHints.length > 0
        ? parsed.drilldownHints.slice(0, 4)
        : fallback.drilldownHints,
      chartSpec: fallback.chartSpec,
      confidence: ["Low", "Medium", "High"].includes(parsed?.confidence) ? parsed.confidence : fallback.confidence,
    });
  } catch (error) {
    return res.status(200).json(fallback);
  }
});

aiRouter.post("/chart/drilldown", async (req, res) => {
  const {
    metricType = "steps",
    timeframe = "week",
    selection = null,
    seriesContext = [],
    question = "What happened here?",
  } = req.body || {};

  if (!Array.isArray(seriesContext) || seriesContext.length === 0) {
    return res.status(400).json({
      answer: "I need chart data to explain that selection.",
      confidence: "Low",
      nextAction: "Try another point after data sync.",
      whatIf: null,
    });
  }

  const stats = calculateStats(seriesContext);
  const base = {
    answer: `${metricType} around this selection is ${stats.avg} on average this ${timeframe}.`,
    confidence: seriesContext.length >= 7 ? "Medium" : "Low",
    nextAction: "Aim for one consistent improvement tomorrow.",
    whatIf: `If you increase by 10%, your average could move to about ${Math.round(stats.avg * 1.1)}.`,
  };

  try {
    const parsed = await askOpenAIJson(
      [
        "You explain chart drilldowns for health trends.",
        "Return JSON keys: answer, confidence, nextAction, whatIf.",
        "answer <= 2 short sentences, concise and clear.",
        "confidence one of Low/Medium/High.",
      ].join(" "),
      { metricType, timeframe, selection, seriesContext, question },
      260
    );

    return res.status(200).json({
      answer: parsed?.answer || base.answer,
      confidence: ["Low", "Medium", "High"].includes(parsed?.confidence) ? parsed.confidence : base.confidence,
      nextAction: parsed?.nextAction || base.nextAction,
      whatIf: parsed?.whatIf || base.whatIf,
    });
  } catch (error) {
    return res.status(200).json(base);
  }
});

module.exports = aiRouter;
