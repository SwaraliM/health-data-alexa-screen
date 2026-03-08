const test = require("node:test");
const assert = require("node:assert/strict");

const {
  answerFollowupFromPayload,
  buildDefaultReportPlan,
  buildFitbitInternalUrl,
  buildPayload,
  buildMicroAnswer,
  inferHeuristicFetchPlan,
  validateReportPlan,
} = require("../services/qnaEngine");

function buildSummaryBundle() {
  const relationship = {
    correlation: 0.82,
    statement: "Higher step days matched higher calorie burn.",
    grouped: [
      { label: "Lower steps", value: 1900 },
      { label: "Higher steps", value: 2450 },
    ],
  };

  return {
    primaryMetric: "steps",
    secondaryMetric: "sleep_minutes",
    metricsShown: ["steps", "sleep_minutes", "calories"],
    normalizedSeries: {
      labels: ["Mon", "Tue", "Wed"],
      valuesByMetric: {
        steps: [9200, 10450, 9800],
        sleep_minutes: [7.1, 7.6, 7.4],
        sleep_efficiency: [86, 88, 85],
        wake_minutes: [24, 18, 20],
        calories: [2150, 2360, 2250],
      },
    },
    metricStatsMap: {
      steps: { current: 9800, avg: 9817, goalProgressPct: 98 },
      sleep_minutes: { current: 7.4, avg: 7.4, goalProgressPct: 93 },
      sleep_efficiency: { current: 85, avg: 86.3, goalProgressPct: null },
      wake_minutes: { current: 20, avg: 20.7, goalProgressPct: null },
      calories: { current: 2250, avg: 2253, goalProgressPct: null },
      steps_intraday: { current: 420, avg: 255, goalProgressPct: null },
    },
    metricComparisonMap: {
      steps: {
        changePct: 11,
        current: [{ label: "This week", value: 9817 }],
        previous: [{ label: "Last week", value: 8820 }],
      },
      sleep_minutes: {
        changePct: 1,
        current: [{ label: "This week", value: 7.4 }],
        previous: [{ label: "Last week", value: 7.3 }],
      },
      sleep_efficiency: {
        changePct: -1,
        current: [{ label: "This week", value: 86.3 }],
        previous: [{ label: "Last week", value: 87.1 }],
      },
      wake_minutes: {
        changePct: -6,
        current: [{ label: "This week", value: 20.7 }],
        previous: [{ label: "Last week", value: 22.0 }],
      },
      calories: {
        changePct: 6,
        current: [{ label: "This week", value: 2253 }],
        previous: [{ label: "Last week", value: 2125 }],
      },
    },
    metricAnomaliesMap: {
      steps: [{ label: "Tue", value: 10450, zScore: 2.2 }],
    },
    relationshipRankings: [
      { primaryMetric: "steps", secondaryMetric: "calories", correlation: 0.82, statement: relationship.statement },
    ],
    relationshipMap: {
      "steps|calories": relationship,
    },
    crossMetricRelationships: relationship,
    currentPeriodStats: { current: 9800, avg: 9817, goalProgressPct: 98 },
    previousPeriodComparison: {
      changePct: 11,
      current: [{ label: "This week", value: 9817 }],
      previous: [{ label: "Last week", value: 8820 }],
    },
    anomalies: [{ label: "Tue", value: 10450, zScore: 2.2 }],
    goalProgress: { goal: 10000, progressPct: 98 },
    sleepStageBreakdown: [
      { name: "Deep", value: 80 },
      { name: "Light", value: 230 },
      { name: "REM", value: 95 },
    ],
    sleepStageComparison: [
      { stage: "Deep", currentMinutes: 80, baselineMinutes: 74 },
      { stage: "REM", currentMinutes: 95, baselineMinutes: 88 },
    ],
    sleepStageTimeline: [
      { clockLabel: "11 PM", stages: { deep: 20, light: 35, rem: 10, wake: 5 } },
      { clockLabel: "1 AM", stages: { deep: 25, light: 45, rem: 15, wake: 3 } },
    ],
    sleepTimingSummary: { bedtime: "10:45 PM", wakeTime: "6:40 AM" },
    intradaySummaryMap: {
      steps_intraday: {
        takeaway: "Afternoons were your busiest time.",
        buckets: [
          { label: "Morning", value: 2400 },
          { label: "Afternoon", value: 4300 },
          { label: "Evening", value: 3100 },
        ],
        windows: [
          { label: "06:00", value: 2400, avgValue: 800 },
          { label: "12:00", value: 4300, avgValue: 1433 },
          { label: "18:00", value: 3100, avgValue: 1033 },
        ],
      },
    },
    intradayInsightsMap: {
      steps_intraday: {
        takeaway: "Afternoons were your busiest time.",
        strongestWindow: { label: "12:00", total: 4300, average: 1433 },
      },
    },
    intradayInsights: {
      takeaway: "Afternoons were your busiest time.",
      strongestWindow: { label: "12:00", total: 4300, average: 1433 },
    },
    intradayWindowSummary: {
      takeaway: "Afternoons were your busiest time.",
      buckets: [
        { label: "Morning", value: 2400 },
        { label: "Afternoon", value: 4300 },
        { label: "Evening", value: 3100 },
      ],
    },
    sleepSeriesBundle: {
      sleep: [
        { label: "Mon", value: 7.1 },
        { label: "Tue", value: 7.6 },
        { label: "Wed", value: 7.4 },
      ],
      efficiency: [
        { label: "Mon", value: 86 },
        { label: "Tue", value: 88 },
        { label: "Wed", value: 85 },
      ],
      wakeMinutes: [
        { label: "Mon", value: 24 },
        { label: "Tue", value: 18 },
        { label: "Wed", value: 20 },
      ],
      bedtimeClock: [
        { label: "Mon", value: 1365 },
        { label: "Tue", value: 1380 },
        { label: "Wed", value: 1370 },
      ],
    },
    sleepStageTrendSeries: {
      deep: [{ label: "Mon", value: 74 }, { label: "Tue", value: 80 }, { label: "Wed", value: 78 }],
      light: [{ label: "Mon", value: 220 }, { label: "Tue", value: 230 }, { label: "Wed", value: 225 }],
      rem: [{ label: "Mon", value: 90 }, { label: "Tue", value: 95 }, { label: "Wed", value: 92 }],
      wake: [{ label: "Mon", value: 24 }, { label: "Tue", value: 18 }, { label: "Wed", value: 20 }],
    },
    sleepQuality: {
      score: 78,
      headline: "Sleep quality looked fairly strong overall.",
      takeaway: "Sleep quality looked fairly strong overall. Sleep efficiency was strong.",
      factors: ["sleep efficiency was strong", "bedtime stayed fairly regular"],
    },
    reportFacts: {
      strongestMetricChange: { metricKey: "steps", changePct: 11, direction: "up" },
      strongestRelationship: { primaryMetric: "steps", secondaryMetric: "calories" },
    },
    storyCandidates: [
      "Overall, activity improved this week while sleep stayed steady.",
    ],
    activitySummary: {
      steps: 9800,
      floors: 12,
      activeMinutes: 74,
      totalActiveZoneMinutes: 36,
      takeaway: "You earned 36 active zone minutes, climbed 12 floors, and logged 74 active minutes.",
    },
    chartContext: {
      highlight: "Activity improved most on Tuesday.",
    },
    timeLabel: "this week",
    timeScope: "this_week",
    timeWindow: { timeframeLabel: "this week" },
    unit: "steps",
    rawSeries: {
      steps: [{ label: "Mon", value: 9200 }],
      steps_intraday: [{ label: "06:00", fullLabel: "06:00", value: 120 }],
    },
  };
}

function buildPlan(overrides = {}) {
  return {
    question_type: "overview_report",
    metrics_needed: ["steps", "sleep_minutes", "calories"],
    time_scope: "this_week",
    comparison_mode: "previous_period",
    response_mode: "multi_panel_report",
    needs_previous_period: true,
    needs_intraday: false,
    layout_hint: "two_up_plus_footer",
    followup_mode: "suggested_drill_down",
    ...overrides,
  };
}

test("validateReportPlan falls back to supported panels and metrics", () => {
  const summaryBundle = buildSummaryBundle();
  const plan = buildPlan();

  const validated = validateReportPlan({
    response_mode: "multi_panel_report",
    layout: "four_panel_grid",
    panels: [
      { panel_id: "bad_panel", goal: "unsupported", metrics: ["hydration"], visual_family: "weird", title: "Bad", subtitle: "Bad" },
    ],
    next_views: [
      { id: "bad_view", label: "Bad view", goal: "deep_dive", metrics: ["hydration"] },
    ],
  }, summaryBundle, plan);

  assert.equal(validated.response_mode, "multi_panel_report");
  assert.equal(validated.layout, "four_panel_grid");
  assert.equal(validated.panels.length, 4);
  assert.deepEqual(
    validated.panels.map((panel) => panel.goal),
    ["overview_report", "comparison_report", "relationship_report", "deep_dive"]
  );
  assert.equal(new Set(validated.panels.map((panel) => panel.visual_family)).size, validated.panels.length);
  assert.deepEqual(
    validated.next_views.map((view) => view.id),
    ["sleep_detail", "intraday_detail", "relationship_detail", "steps_detail"]
  );
});

test("buildPayload preserves the new report contract and compatibility aliases", () => {
  const summaryBundle = buildSummaryBundle();
  const plan = buildPlan();
  const presentation = buildDefaultReportPlan("Am I doing better overall this week?", plan, summaryBundle);

  const payload = buildPayload({
    requestId: "req-123",
    question: "Am I doing better overall this week?",
    plan,
    fetched: null,
    summaryBundle,
    presentation,
    voiceAnswerOverride: "Overall, you did a little better this week.",
  });

  assert.equal(payload.status, "ready");
  assert.equal(payload.response_mode, "multi_panel_report");
  assert.equal(payload.layout, "four_panel_grid");
  assert.equal(payload.spoken_answer, "Overall, you did a little better this week.");
  assert.equal(payload.voice_answer, payload.spoken_answer);
  assert.equal(payload.primary_answer, payload.takeaway);
  assert.equal(payload.primary_visual, payload.panels[0].chart_spec);
  assert.equal(payload.chart_spec, payload.primary_visual);
  assert.equal(payload.stages.length, payload.panels.length);
  assert.deepEqual(
    payload.suggestedDrillDowns,
    payload.next_views.map((view) => view.label).slice(0, 3)
  );
  assert.equal(payload.summary.shortSpeech, payload.voice_answer);
  assert.equal(payload.panels[0].emphasis, "hero");
});

test("buildPayload includes GPT trace only when provided", () => {
  const summaryBundle = buildSummaryBundle();
  const plan = buildPlan();
  const presentation = buildDefaultReportPlan("What stands out lately?", plan, summaryBundle);

  const payload = buildPayload({
    requestId: "req-debug",
    question: "What stands out lately?",
    plan,
    fetched: null,
    summaryBundle,
    presentation,
    debug: {
      gpt_trace: {
        planner: {
          status: "ok",
          used_fallback: false,
          request_summary: "planner input",
          response_summary: "planner output",
          error_message: "",
        },
      },
    },
  });
  const plainPayload = buildPayload({
    requestId: "req-no-debug",
    question: "What stands out lately?",
    plan,
    fetched: null,
    summaryBundle,
    presentation,
  });

  assert.equal(payload.debug.gpt_trace.planner.status, "ok");
  assert.equal(plainPayload.debug, undefined);
});

test("answerFollowupFromPayload deepens the active panel for tell me more prompts", async () => {
  const summaryBundle = buildSummaryBundle();
  const plan = buildPlan();
  const presentation = buildDefaultReportPlan("What stands out lately?", plan, summaryBundle);
  const payload = buildPayload({
    requestId: "req-continue",
    question: "What stands out lately?",
    plan,
    fetched: null,
    summaryBundle,
    presentation,
  });

  const result = await answerFollowupFromPayload({
    payload,
    question: "show more",
  });

  assert.ok(result.payload);
  assert.equal(result.payload.response_mode, "single_view");
  assert.equal(result.payload.activePanelId, payload.activePanelId);
  assert.equal(result.payload.panels[0].metrics[0], payload.panels[0].metrics[0]);
  assert.match(result.payload.report_title, /detail/i);
});

test("answerFollowupFromPayload targets a named drill-down from next_views", async () => {
  const summaryBundle = buildSummaryBundle();
  const plan = buildPlan();
  const presentation = buildDefaultReportPlan("How are my metrics related?", plan, summaryBundle);
  const payload = buildPayload({
    requestId: "req-next-view",
    question: "How are my metrics related?",
    plan,
    fetched: null,
    summaryBundle,
    presentation,
  });

  const result = await answerFollowupFromPayload({
    payload,
    question: "show sleep detail",
  });

  assert.ok(result.payload);
  assert.equal(result.payload.response_mode, "single_view");
  assert.equal(result.payload.activePanelId, "sleep_detail");
  assert.equal(result.payload.report_title, "Sleep detail");
  assert.deepEqual(result.payload.panels[0].metrics, ["sleep_minutes"]);
  assert.equal(result.payload.panels[0].visual_family, "timeline");
  assert.equal(result.payload.panels[0].chart_spec.chart_type, "stacked_bar");
  assert.deepEqual(
    result.payload.panels[0].chart_spec.option.series.map((series) => series.name),
    ["Deep", "Light", "REM", "Wake"]
  );
});

test("sleep efficiency panels render efficiency data instead of sleep stage stacks", () => {
  const summaryBundle = {
    ...buildSummaryBundle(),
    primaryMetric: "sleep_efficiency",
    metricsShown: ["sleep_efficiency"],
    intradaySummaryMap: {},
    intradayInsightsMap: {},
    intradayWindowSummary: null,
    intradayInsights: null,
    unit: "%",
  };
  const plan = buildPlan({
    question_type: "chart_explanation",
    metrics_needed: ["sleep_efficiency"],
    response_mode: "single_view",
  });

  const payload = buildPayload({
    requestId: "req-sleep-efficiency",
    question: "How was my sleep efficiency this week?",
    plan,
    fetched: null,
    summaryBundle,
    presentation: {
      response_mode: "single_view",
      layout: "single_focus",
      panels: [
        {
          panel_id: "sleep_efficiency_explained",
          goal: "chart_explanation",
          metrics: ["sleep_efficiency"],
          visual_family: "timeline",
          title: "Sleep efficiency",
          subtitle: "This week",
          emphasis: "hero",
        },
      ],
      next_views: [],
      report_title: "Sleep efficiency",
      takeaway: "Sleep efficiency held fairly steady.",
      spoken_answer: "Sleep efficiency held fairly steady.",
    },
    voiceAnswerOverride: "Sleep efficiency held fairly steady.",
    voiceAnswerSource: "gpt",
  });

  const chartSpec = payload.panels[0].chart_spec;
  assert.equal(chartSpec.option.series.length, 1);
  assert.deepEqual(chartSpec.option.series[0].data, [86, 88, 85]);
  assert.ok(!["stacked_bar", "multi_line", "pie"].includes(chartSpec.chart_type));
  assert.ok(chartSpec.option.series.every((series) => !["Deep", "Light", "REM", "Wake"].includes(series.name)));
});

test("single-day questions request intraday evidence by default when supported", () => {
  const plan = inferHeuristicFetchPlan("How was my heart rate today?");
  assert.equal(plan.time_scope, "today");
  assert.equal(plan.needs_intraday, true);
  assert.ok(plan.evidence_scope.includes("daily_activity_breakdown"));
});

test("single-day sleep questions use the single-day sleep endpoint path", () => {
  const url = buildFitbitInternalUrl({
    username: "amy",
    metricKey: "sleep_minutes",
    startDate: "2026-03-01",
    endDate: "2026-03-01",
    timeScope: "last_night",
  });
  assert.match(url, /\/sleep\/single-day\/date\/2026-03-01$/);
});

test("multi-day sleep questions use the sleep range endpoint path", () => {
  const url = buildFitbitInternalUrl({
    username: "amy",
    metricKey: "sleep_minutes",
    startDate: "2026-02-23",
    endDate: "2026-03-01",
    timeScope: "last_7_days",
  });
  assert.match(url, /\/sleep\/range\/date\/2026-02-23\/2026-03-01$/);
});

test("breathing rate and blood oxygen questions use their dedicated Fitbit endpoint paths", () => {
  const brUrl = buildFitbitInternalUrl({
    username: "amy",
    metricKey: "breathing_rate",
    startDate: "2026-03-01",
    endDate: "2026-03-01",
    timeScope: "last_night",
  });
  const spo2Url = buildFitbitInternalUrl({
    username: "amy",
    metricKey: "spo2",
    startDate: "2026-02-23",
    endDate: "2026-03-01",
    timeScope: "last_7_days",
  });

  assert.match(brUrl, /\/br\/single-day\/date\/2026-03-01$/);
  assert.match(spo2Url, /\/spo2\/range\/date\/2026-02-23\/2026-03-01$/);
});

test("body metrics use the Fitbit body log endpoints", () => {
  const weightUrl = buildFitbitInternalUrl({
    username: "amy",
    metricKey: "weight",
    startDate: "2026-02-23",
    endDate: "2026-03-01",
    timeScope: "last_7_days",
  });
  const fatUrl = buildFitbitInternalUrl({
    username: "amy",
    metricKey: "body_fat",
    startDate: "2026-03-01",
    endDate: "2026-03-01",
    timeScope: "today",
  });

  assert.match(weightUrl, /\/body\/log\/weight\/date\/2026-02-23\/2026-03-01$/);
  assert.match(fatUrl, /\/body\/log\/fat\/date\/2026-03-01$/);
});

test("heuristic planner recognizes breathing, blood oxygen, and body questions", () => {
  const sleepRespPlan = inferHeuristicFetchPlan("How were my breathing rate and blood oxygen last night?");
  const bodyPlan = inferHeuristicFetchPlan("How has my body fat changed lately?");

  assert.ok(sleepRespPlan.metrics_needed.includes("breathing_rate"));
  assert.ok(sleepRespPlan.metrics_needed.includes("spo2"));
  assert.ok(sleepRespPlan.evidence_scope.includes("sleep_timing_and_stages"));
  assert.ok(bodyPlan.metrics_needed.includes("body_fat"));
});

test("sleep micro-answer prefers balanced sleep-quality takeaway", () => {
  const answer = buildMicroAnswer({
    questionType: "single_metric_status",
    summaryBundle: {
      ...buildSummaryBundle(),
      primaryMetric: "sleep_minutes",
      currentPeriodStats: { current: 7.4, avg: 7.4 },
      unit: "hours",
    },
  });
  assert.match(answer, /sleep quality looked fairly strong overall/i);
});

test("activity micro-answer uses detailed activity summary when available", () => {
  const answer = buildMicroAnswer({
    questionType: "single_metric_status",
    summaryBundle: {
      ...buildSummaryBundle(),
      primaryMetric: "steps",
      timeScope: "today",
    },
  });
  assert.match(answer, /active zone minutes/i);
  assert.match(answer, /floors/i);
});

test("follow-up explanation uses active panel evidence before fallback", async () => {
  const summaryBundle = buildSummaryBundle();
  const plan = buildPlan();
  const presentation = buildDefaultReportPlan("How did I sleep last night?", plan, {
    ...summaryBundle,
    primaryMetric: "sleep_minutes",
    currentPeriodStats: { current: 7.4, avg: 7.4 },
    metricsShown: ["sleep_minutes", "steps", "calories"],
  });
  const payload = buildPayload({
    requestId: "req-explain",
    question: "How did I sleep last night?",
    plan,
    fetched: null,
    summaryBundle: {
      ...summaryBundle,
      primaryMetric: "sleep_minutes",
      currentPeriodStats: { current: 7.4, avg: 7.4 },
      metricsShown: ["sleep_minutes", "steps", "calories"],
    },
    presentation,
  });

  const result = await answerFollowupFromPayload({
    payload,
    question: "explain that",
  });

  assert.match(result.answer, /sleep quality looked fairly strong overall/i);
});

test("unmatched follow-up falls back safely and attaches followup trace", async () => {
  const summaryBundle = buildSummaryBundle();
  const plan = buildPlan();
  const presentation = buildDefaultReportPlan("Am I doing better overall this week?", plan, summaryBundle);
  const payload = buildPayload({
    requestId: "req-followup-debug",
    question: "Am I doing better overall this week?",
    plan,
    fetched: null,
    summaryBundle,
    presentation,
  });

  const result = await answerFollowupFromPayload({
    payload,
    question: "tell me something unexpected about this",
  });

  assert.equal(result.answer_ready, false);
  assert.ok(result.payload?.debug?.gpt_trace?.followup);
  assert.ok(["skipped", "ok", "fallback", "error", "timeout", "http_error", "invalid_json"].includes(result.payload.debug.gpt_trace.followup.status));
});
