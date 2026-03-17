const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createStageRecord,
  getLatestStage,
  hasStoredStage,
  normalizeExecutorStageOutput,
  normalizeRequestedStageIndex,
  replayStoredStage,
} = require("../stageService");

function buildBundleWithStages() {
  const stage0 = createStageRecord({
    stageIndex: 0,
    title: "Stage 1",
    spokenText: "First stage answer",
    screenText: "First stage screen",
    chartSpec: { chart_type: "line", title: "Stage 1", takeaway: "First", option: {} },
    source: "executor_stage1",
  });
  const stage1 = createStageRecord({
    stageIndex: 1,
    title: "Stage 2",
    spokenText: "Second stage answer",
    screenText: "Second stage screen",
    chartSpec: { chart_type: "bar", title: "Stage 2", takeaway: "Second", option: {} },
    source: "executor_stage_next",
  });
  return {
    bundleId: "bundle_stage_replay",
    question: "How did I sleep this week?",
    metricsRequested: ["sleep_minutes"],
    currentStageIndex: 1,
    stages: [stage0, stage1],
  };
}

test("replayStoredStage returns a deterministic payload from stored stage memory", () => {
  const bundle = buildBundleWithStages();
  const replayed = replayStoredStage({
    bundle,
    stageIndex: 1,
    requestId: "req_replay_1",
    question: "show stage 2",
  });

  assert.equal(replayed.ok, true);
  assert.equal(replayed.reason, "replayed_stored_stage");
  assert.equal(replayed.stage.stageIndex, 1);
  assert.equal(replayed.payload.activeStageIndex, 1);
  assert.equal(replayed.payload.voice_answer, "Second stage answer");
  assert.equal(replayed.payload.report_title, "Stage 2");
});

test("hasStoredStage and getLatestStage helpers match the bundle memory state", () => {
  const bundle = buildBundleWithStages();
  assert.equal(hasStoredStage(bundle, 0), true);
  assert.equal(hasStoredStage(bundle, 1), true);
  assert.equal(hasStoredStage(bundle, 2), false);
  assert.equal(getLatestStage(bundle)?.stageIndex, 1);
});

test("normalizeRequestedStageIndex safely clamps unexpected inputs", () => {
  assert.equal(normalizeRequestedStageIndex(null, 3), 3);
  assert.equal(normalizeRequestedStageIndex("latest", 3), 3);
  assert.equal(normalizeRequestedStageIndex("stage 2", 3), 2);
  assert.equal(normalizeRequestedStageIndex(99, 3), 3);
  assert.equal(normalizeRequestedStageIndex(-5, 3), 0);
});

test("normalizeExecutorStageOutput enforces narrated stage fields and voice followups", () => {
  const normalized = normalizeExecutorStageOutput({
    executorOutput: {
      title: "Sleep trend",
      spoken_text: "Your sleep has been steady this week",
      screen_text: "Steady sleep trend this week",
      chart_spec: {
        chart_type: "line",
        title: "Sleep trend",
        takeaway: "Sleep stayed steady.",
        option: {},
      },
      suggested_followups: ["next", "what does this mean"],
      more_available: true,
    },
    stageIndex: 0,
    requestId: "req_stage_norm",
    question: "How did I sleep this week?",
  });

  assert.equal(normalized.stageIndex, 0);
  assert.match(normalized.spokenText, /on the screen/i);
  assert.match(normalized.spokenText, /(line|chart)/i);
  assert.equal(Array.isArray(normalized.suggestedFollowups), true);
  assert.equal(normalized.suggestedFollowups.includes("show more"), true);
  assert.equal(normalized.suggestedFollowups.includes("what does this mean"), true);
  assert.equal(normalized.metadata.voiceFirst, true);
});

test("normalizeExecutorStageOutput parses chart_spec.option JSON string into object", () => {
  const normalized = normalizeExecutorStageOutput({
    executorOutput: {
      title: "Steps trend",
      spoken_text: "Here is your steps trend.",
      screen_text: "Steps are moving up.",
      chart_spec: {
        chart_type: "line",
        title: "Steps trend",
        takeaway: "Steps increased.",
        option: JSON.stringify({
          xAxis: { type: "category", data: ["Mon", "Tue"] },
          yAxis: { type: "value" },
          series: [{ type: "line", data: [4500, 6200] }],
        }),
      },
      suggested_followups: ["show more"],
      more_available: true,
    },
    stageIndex: 0,
    requestId: "req_stage_option_string",
    question: "How are my steps?",
  });

  assert.equal(typeof normalized.chartSpec.option, "object");
  assert.equal(Array.isArray(normalized.chartSpec.option.series), true);
  assert.equal(normalized.chartSpec.option.series.length, 1);
});

test("normalizeExecutorStageOutput falls back to a valid option object when chart option is invalid", () => {
  const normalized = normalizeExecutorStageOutput({
    executorOutput: {
      title: "Recovery view",
      spoken_text: "Here is your recovery view.",
      screen_text: "Recovery stayed consistent.",
      chart_spec: {
        chart_type: "line",
        title: "Recovery view",
        takeaway: "Recovery stayed consistent.",
        option: "not-json",
      },
      suggested_followups: ["show more"],
      more_available: true,
    },
    stageIndex: 0,
    requestId: "req_stage_option_invalid",
    question: "How is my recovery?",
  });

  assert.equal(typeof normalized.chartSpec.option, "object");
  assert.equal(Array.isArray(normalized.chartSpec.option.items), true);
  assert.equal(Array.isArray(normalized.chartSpec.option.graphic), true);
});
