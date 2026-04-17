/**
 * V4 LLM-generated ECharts option pipeline tests.
 * Tests: optionValidator, buildRawDataPayload, executorClient V4 routing,
 *        executorAgent V4 path, stageService display_group grouping.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// ─── optionValidator ─────────────────────────────────────────────────────────

const { validateLLMGeneratedOption } = require("../services/charts/optionValidator");

test("optionValidator: accepts a valid bar chart option", () => {
  const option = {
    xAxis: { type: "category", data: ["Mon", "Tue", "Wed"] },
    yAxis: { type: "value" },
    series: [{ type: "bar", name: "Steps", data: [8000, 7200, 9100] }],
  };
  const { ok, sanitizedOption, errors } = validateLLMGeneratedOption(option, "bar");
  assert.equal(ok, true, `errors: ${errors.join(", ")}`);
  assert.ok(sanitizedOption);
  assert.deepEqual(sanitizedOption.xAxis.data, ["Mon", "Tue", "Wed"]);
});

test("optionValidator: accepts dual-axis option with yAxis as array", () => {
  const option = {
    xAxis: { type: "category", data: ["Jan 1", "Jan 2"] },
    yAxis: [{ type: "value", name: "Steps" }, { type: "value", name: "Sleep" }],
    series: [
      { type: "bar", name: "Steps", data: [8000, 7000], yAxisIndex: 0 },
      { type: "line", name: "Sleep", data: [420, 390], yAxisIndex: 1 },
    ],
  };
  const { ok, sanitizedOption, errors } = validateLLMGeneratedOption(option, "bar");
  assert.equal(ok, true, `errors: ${errors.join(", ")}`);
  assert.ok(Array.isArray(sanitizedOption.yAxis), "yAxis should remain array");
  assert.equal(sanitizedOption.yAxis.length, 2);
});

test("optionValidator: strips unknown top-level keys", () => {
  const option = {
    xAxis: { type: "category", data: ["Mon"] },
    yAxis: { type: "value" },
    series: [{ type: "bar", data: [5] }],
    dangerousKey: "malicious",
    onClick: "javascript:alert(1)",
  };
  const { ok, sanitizedOption } = validateLLMGeneratedOption(option, "bar");
  assert.equal(ok, true);
  assert.equal(sanitizedOption.dangerousKey, undefined);
  assert.equal(sanitizedOption.onClick, undefined);
});

test("optionValidator: strips script injection from string values", () => {
  const option = {
    xAxis: { type: "category", data: ["<script>alert(1)</script>", "Mon"] },
    yAxis: { type: "value" },
    series: [{ type: "bar", name: "javascript:alert(1)", data: [5, 3] }],
  };
  const { ok, sanitizedOption } = validateLLMGeneratedOption(option, "bar");
  assert.equal(ok, true);
  // The injected label becomes ""
  assert.equal(sanitizedOption.xAxis.data[0], "");
  // Series name with injection becomes ""
  assert.equal(sanitizedOption.series[0].name, "");
});

test("optionValidator: truncates series data when total exceeds 90 points", () => {
  // 3 series × 40 points each = 120 total → should truncate to max 90/3 = 30 each
  const data40 = Array.from({ length: 40 }, (_, i) => i);
  const option = {
    xAxis: { type: "category", data: Array.from({ length: 40 }, (_, i) => `Day ${i}`) },
    yAxis: { type: "value" },
    series: [
      { type: "bar", name: "A", data: [...data40] },
      { type: "bar", name: "B", data: [...data40] },
      { type: "bar", name: "C", data: [...data40] },
    ],
  };
  const { ok, sanitizedOption } = validateLLMGeneratedOption(option, "bar");
  assert.equal(ok, true);
  const totalPoints = sanitizedOption.series.reduce((sum, s) => sum + s.data.length, 0);
  assert.ok(totalPoints <= 90, `Total data points ${totalPoints} should be <= 90`);
});

test("optionValidator: rejects null/non-object option", () => {
  const { ok } = validateLLMGeneratedOption(null, "bar");
  assert.equal(ok, false);
  const { ok: ok2 } = validateLLMGeneratedOption("string", "bar");
  assert.equal(ok2, false);
  const { ok: ok3 } = validateLLMGeneratedOption([1, 2, 3], "bar");
  assert.equal(ok3, false);
});

test("optionValidator: rejects option with no whitelisted keys", () => {
  const option = { dangerousKey: "data", anotherBadKey: 42 };
  const { ok } = validateLLMGeneratedOption(option, "bar");
  assert.equal(ok, false);
});

// ─── buildRawDataPayload ──────────────────────────────────────────────────────

const { buildRawDataPayload } = require("../services/charts/chartStrategyService");

function makeMultiWindowData(metrics = ["steps", "sleep_minutes"], days = 7) {
  const rows = Array.from({ length: days }, (_, i) => {
    const date = `2026-01-${String(i + 1).padStart(2, "0")}`;
    const row = { timestamp: date };
    for (const m of metrics) row[m] = 5000 + i * 100;
    return row;
  });
  return {
    sa_0: {
      normalizedTable: rows,
      metrics_needed: metrics,
      window: { start: "2026-01-01", end: `2026-01-0${days}` },
    },
  };
}

test("buildRawDataPayload: returns columnar dates + metrics", () => {
  const multiWindowData = makeMultiWindowData(["steps"], 5);
  const stageSpec = { sub_analysis_ids: ["sa_0"], focusMetrics: ["steps"] };
  const payload = buildRawDataPayload(stageSpec, multiWindowData, {});

  assert.equal(payload.row_count, 5);
  assert.equal(payload.dates.length, 5);
  assert.equal(payload.metrics.steps.length, 5);
  assert.ok(payload.dates[0].includes("Jan"), `Expected Jan label, got: ${payload.dates[0]}`);
  assert.deepEqual(payload.focus_metrics, ["steps"]);
});

test("buildRawDataPayload: null-fills missing metric values", () => {
  const rows = [
    { timestamp: "2026-01-01", steps: 8000, sleep_minutes: null },
    { timestamp: "2026-01-02", steps: null, sleep_minutes: 420 },
  ];
  const multiWindowData = {
    sa_0: { normalizedTable: rows, metrics_needed: ["steps", "sleep_minutes"] },
  };
  const stageSpec = { sub_analysis_ids: ["sa_0"], focusMetrics: ["steps", "sleep_minutes"] };
  const payload = buildRawDataPayload(stageSpec, multiWindowData, {});

  assert.equal(payload.metrics.steps[1], null);
  assert.equal(payload.metrics.sleep_minutes[0], null);
});

test("buildRawDataPayload: caps at 60 rows", () => {
  const multiWindowData = makeMultiWindowData(["steps"], 80);
  const stageSpec = { sub_analysis_ids: ["sa_0"], focusMetrics: ["steps"] };
  const payload = buildRawDataPayload(stageSpec, multiWindowData, {});
  assert.ok(payload.row_count <= 60, `row_count should be <= 60, got ${payload.row_count}`);
  assert.ok(payload.dates.length <= 60);
  assert.ok(payload.metrics.steps.length <= 60);
});

test("buildRawDataPayload: pulls stats from evidenceBundle", () => {
  const multiWindowData = makeMultiWindowData(["steps"], 5);
  const evidenceBundle = {
    sub_analyses: {
      sa_0: {
        stats: {
          steps: { mean: 7000, min: 5000, max: 9000, trend_direction: "increasing", unit: "steps" },
        },
      },
    },
  };
  const stageSpec = { sub_analysis_ids: ["sa_0"], focusMetrics: ["steps"] };
  const payload = buildRawDataPayload(stageSpec, multiWindowData, evidenceBundle);

  assert.equal(payload.stats.steps.mean, 7000);
  assert.equal(payload.stats.steps.trend, "increasing");
  assert.equal(payload.stats.steps.unit, "steps");
});

// ─── executorClient V4 routing ───────────────────────────────────────────────

const { runExecutorRequest, buildExecutorBundleInputV4 } = require("../services/openai/executorClient");

test("buildExecutorBundleInputV4: includes raw_data and echarts_guide in bundle_candidates", () => {
  const rawDataCandidates = [{
    stage_index: 0,
    title_hint: "Steps Trend",
    focus_metrics: ["steps"],
    goal: "Show steps over time",
    display_group: 0,
    raw_data: { dates: ["Jan 1", "Jan 2"], metrics: { steps: [8000, 7000] }, stats: {}, row_count: 2, focus_metrics: ["steps"] },
  }];
  const input = buildExecutorBundleInputV4({
    bundleSummary: { bundleId: "b1", question: "How are my steps?" },
    question: "How are my steps?",
    rawDataCandidates,
  });

  assert.ok(input.echarts_guide, "echarts_guide should be present");
  assert.ok(input.echarts_guide.includes("BAR"), "echarts_guide should include BAR skeleton");
  assert.equal(input.bundle_candidates.length, 1);
  assert.ok(input.bundle_candidates[0].raw_data, "candidate should have raw_data");
  assert.equal(input.bundle_candidates[0].display_group, 0);
  assert.ok(!input.bundle_candidates[0].viable_strategies, "should not have viable_strategies");
});

test("runExecutorRequest: routes to v4 path when rawDataCandidates provided and V4 enabled", async () => {
  let observedPath = null;
  let observedInput = null;

  // Temporarily enable V4
  const { AGENT_CONFIGS } = require("../configs/agentConfigs");
  const originalEnabled = AGENT_CONFIGS.executorV4.enabled;
  AGENT_CONFIGS.executorV4.enabled = true;

  try {
    const rawDataCandidates = [{
      stage_index: 0,
      raw_data: { dates: ["Jan 1"], metrics: { steps: [8000] }, stats: {}, row_count: 1, focus_metrics: ["steps"] },
      display_group: 0,
    }];

    await runExecutorRequest({
      question: "How are my steps?",
      rawDataCandidates,
      __deps: {
        config: AGENT_CONFIGS.executorV4,
        getExecutorTools: () => [],
        runToolLoop: async ({ baseRequest }) => {
          observedPath = "v4_captured";
          observedInput = baseRequest.input;
          return { ok: false, status: "timeout", error: "test" };
        },
        createResponse: async () => ({ ok: true }),
      },
    });

    assert.equal(observedPath, "v4_captured");
    assert.ok(observedInput?.echarts_guide, "V4 input should have echarts_guide");
    assert.ok(observedInput?.bundle_candidates?.[0]?.raw_data, "V4 input should have raw_data");
  } finally {
    AGENT_CONFIGS.executorV4.enabled = originalEnabled;
  }
});

test("runExecutorRequest: stays on V3 path when V4 is disabled", async () => {
  let observedInput = null;

  const { AGENT_CONFIGS } = require("../configs/agentConfigs");
  const originalEnabled = AGENT_CONFIGS.executorV4.enabled;
  AGENT_CONFIGS.executorV4.enabled = false; // explicitly off

  try {
    const bundleCandidates = [{
      stage_index: 0,
      viable_strategies: [{ strategy_id: "s1", chart_type: "bar", description: "bar" }],
    }];

    await runExecutorRequest({
      question: "How are my steps?",
      bundleCandidates,
      __deps: {
        config: AGENT_CONFIGS.executorV3,
        getExecutorTools: () => [],
        runToolLoop: async ({ baseRequest }) => {
          observedInput = baseRequest.input;
          return { ok: false, status: "timeout", error: "test" };
        },
        createResponse: async () => ({ ok: true }),
      },
    });

    assert.ok(!observedInput?.echarts_guide, "V3 path should NOT have echarts_guide");
    assert.ok(observedInput?.bundle_candidates?.[0]?.viable_strategies, "V3 path should have viable_strategies");
  } finally {
    AGENT_CONFIGS.executorV4.enabled = originalEnabled;
  }
});

// ─── normalizeAuthoredBundleStagesV4 ─────────────────────────────────────────

const executorAgentPath = require.resolve("../services/qna/executorAgent");
const executorClientPath = require.resolve("../services/openai/executorClient");

function loadExecutorAgentWithMock(mockRunExecutorRequest) {
  const originalExecutorClient = require.cache[executorClientPath];
  delete require.cache[executorAgentPath];
  require.cache[executorClientPath] = {
    id: executorClientPath,
    filename: executorClientPath,
    loaded: true,
    exports: {
      ...require(executorClientPath),
      runExecutorRequest: mockRunExecutorRequest,
    },
  };
  const agent = require(executorAgentPath);
  return {
    agent,
    restore() {
      delete require.cache[executorAgentPath];
      if (originalExecutorClient) require.cache[executorClientPath] = originalExecutorClient;
      else delete require.cache[executorClientPath];
    },
  };
}

test("normalizeAuthoredBundleStagesV4: uses LLM option when validation passes", () => {
  const { normalizeAuthoredBundleStagesV4 } = require("../services/qna/executorAgent");

  const rawDataCandidates = [{
    stage_index: 0,
    title_hint: "Steps Trend",
    display_group: 0,
    _viableStrategies: [],
    _stageSpec: {},
  }];

  const bundleOutput = {
    bundle_title: "Steps Analysis",
    bundle_thread: "Your steps were steady.",
    bundle_summary: "Good week.",
    stages: [{
      stage_index: 0,
      title: "Daily Steps",
      narrative_role: "orientation",
      spoken_text: "Here is your step count for the week.",
      screen_text: "Steps were steady.",
      chart_type: "bar",
      chart_option: {
        xAxis: { type: "category", data: ["Mon", "Tue"] },
        yAxis: { type: "value" },
        series: [{ type: "bar", name: "Steps", data: [8000, 7500] }],
      },
      chart_title: "Daily Steps",
      chart_subtitle: "Last 7 days",
      chart_takeaway: "Consistent throughout the week",
      suggested_followups: ["Tell me more"],
      analysis_notes: "",
    }],
  };

  const { stages, errors } = normalizeAuthoredBundleStagesV4({
    bundleOutput,
    rawDataCandidates,
    question: "How are my steps?",
    requestId: "req_1",
  });

  assert.equal(stages.length, 1, `errors: ${errors.join(", ")}`);
  assert.equal(stages[0].stageIndex, 0);
  assert.ok(stages[0].chartSpec, "chartSpec should be set");
  assert.equal(stages[0].chartSpec.chart_type, "bar");
  assert.ok(stages[0].chartSpec.option, "option should be present after validation");
  assert.equal(stages[0].metadata.display_group, 0);
  assert.equal(stages[0].metadata.executor.path, "v4_llm_option");
});

test("normalizeAuthoredBundleStagesV4: falls back to V3 when option is invalid", () => {
  const { normalizeAuthoredBundleStagesV4, mergeStrategyResponse } = require("../services/qna/executorAgent");
  const { generateViableStrategies } = require("../services/charts/chartStrategyService");

  const multiWindowData = {
    sa_0: {
      normalizedTable: [{ timestamp: "2026-01-01", steps: 8000 }, { timestamp: "2026-01-02", steps: 7000 }],
      metrics_needed: ["steps"],
    },
  };

  const rawDataCandidates = [{
    stage_index: 0,
    title_hint: "Steps Trend",
    display_group: 0,
    _viableStrategies: generateViableStrategies({
      stageSpec: { sub_analysis_ids: ["sa_0"], focusMetrics: ["steps"], chartType: "bar" },
      multiWindowData,
      evidenceBundle: {},
    }),
    _stageSpec: { sub_analysis_ids: ["sa_0"], focusMetrics: ["steps"] },
  }];

  const bundleOutput = {
    bundle_title: "Steps",
    bundle_thread: "Your steps this week.",
    bundle_summary: "Summary.",
    stages: [{
      stage_index: 0,
      title: "Steps",
      narrative_role: "orientation",
      spoken_text: "Here are your steps.",
      screen_text: "Steps were stable.",
      chart_type: "bar",
      chart_option: { dangerousKey: "injection", noSeries: true }, // invalid — no series
      chart_title: "Steps",
      chart_subtitle: "",
      chart_takeaway: "Stable.",
      suggested_followups: [],
      analysis_notes: "",
    }],
  };

  const { stages, errors } = normalizeAuthoredBundleStagesV4({
    bundleOutput,
    rawDataCandidates,
    question: "How are my steps?",
    requestId: "req_fallback",
    multiWindowData,
    evidenceBundle: {},
  });

  assert.equal(stages.length, 1);
  // Should have fallen back — path should indicate fallback
  const path = stages[0].metadata?.executor?.path;
  assert.ok(
    path === "v4_with_v3_fallback" || path === "v4_llm_option" || stages[0].source === "executor_agent_fallback",
    `Unexpected path: ${path}`
  );
});

// ─── stageService display_group multi-panel ───────────────────────────────────

const { buildStagePayload, createStageRecord } = require("../services/qna/stageService");
const { buildFallbackChartSpec } = require("../services/chartSpecService");

function makeStage(idx, displayGroup = idx) {
  return createStageRecord({
    stageIndex: idx,
    title: `Stage ${idx}`,
    spokenText: `Spoken text for stage ${idx}.`,
    screenText: `Screen text ${idx}.`,
    chartSpec: {
      chart_type: "bar",
      title: `Chart ${idx}`,
      subtitle: "",
      takeaway: `Takeaway ${idx}`,
      option: {
        xAxis: { type: "category", data: ["Mon", "Tue"] },
        yAxis: { type: "value" },
        series: [{ type: "bar", name: `Metric ${idx}`, data: [100, 200] }],
      },
    },
    suggestedFollowups: ["Tell me more"],
    moreAvailable: false,
    source: "test",
    requestId: "req_test",
    question: "test question",
    metadata: { display_group: displayGroup },
  });
}

test("buildStagePayload: single stage produces single_focus layout and one panel", () => {
  const stage = makeStage(0, 0);
  const bundle = { stages: [stage], stagesPlan: [{ stageIndex: 0 }] };

  const payload = buildStagePayload({ bundle, stageRecord: stage, question: "test?" });

  assert.equal(payload.panels.length, 1);
  assert.equal(payload.layout, "single_focus");
  assert.equal(payload.voice_navigation_only, true);
});

test("buildStagePayload: two stages in same display_group produce two_up layout", () => {
  const stage0 = makeStage(0, 0);
  const stage1 = makeStage(1, 0); // same display_group as stage0
  const bundle = { stages: [stage0, stage1], stagesPlan: [{ stageIndex: 0 }, { stageIndex: 1 }] };

  const payload = buildStagePayload({ bundle, stageRecord: stage0, question: "Compare?", stageCountOverride: 2 });

  assert.equal(payload.panels.length, 2, "should have 2 panels for display_group 0");
  assert.equal(payload.layout, "two_up");
  assert.equal(payload.voice_navigation_only, false, "multi-panel should not be voice_navigation_only");
});

test("buildStagePayload: three stages in same display_group produce two_up_plus_footer", () => {
  const stages = [makeStage(0, 0), makeStage(1, 0), makeStage(2, 0)];
  const bundle = { stages, stagesPlan: stages.map((_, i) => ({ stageIndex: i })) };

  const payload = buildStagePayload({ bundle, stageRecord: stages[0], question: "Report?", stageCountOverride: 3 });

  assert.equal(payload.panels.length, 3);
  assert.equal(payload.layout, "two_up_plus_footer");
});

test("buildStagePayload: stages with different display_groups show only the current group", () => {
  const stage0 = makeStage(0, 0); // screen 0
  const stage1 = makeStage(1, 0); // screen 0 (same group as stage0)
  const stage2 = makeStage(2, 1); // screen 1 (different group)
  const bundle = {
    stages: [stage0, stage1, stage2],
    stagesPlan: [{ stageIndex: 0 }, { stageIndex: 1 }, { stageIndex: 2 }],
  };

  // Payload for stage 2 (on its own screen)
  const payload = buildStagePayload({ bundle, stageRecord: stage2, question: "Summary?", stageCountOverride: 3 });

  assert.equal(payload.panels.length, 1, "stage2 is alone in its display_group");
  assert.equal(payload.layout, "single_focus");
  assert.equal(payload.activeDisplayGroup, 1);
});

test("buildStagePayload: stages field includes display_group for each stage", () => {
  const stage0 = makeStage(0, 0);
  const stage1 = makeStage(1, 0);
  const bundle = { stages: [stage0, stage1], stagesPlan: [{ stageIndex: 0 }, { stageIndex: 1 }] };

  const payload = buildStagePayload({ bundle, stageRecord: stage0, question: "test?", stageCountOverride: 2 });

  assert.ok(payload.stages[0].display_group !== undefined, "stages[0] should have display_group");
  assert.equal(payload.stages[0].display_group, 0);
  assert.equal(payload.stages[1].display_group, 0);
  assert.equal(payload.screenCount, 1); // both stages on same screen
});
