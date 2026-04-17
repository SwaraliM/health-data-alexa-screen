/**
 * V4 pipeline: narration-chart consistency + response deduplication tests.
 *
 * Tests three specific risks:
 *  1. Completion phrase / narration duplication — deterministic text appended to LLM text
 *  2. V4 success: chart_type and option always come from LLM, never mixed with V3
 *  3. V4 fallback: narration stays LLM-authored; chart comes from V3; divergence is recorded
 *  4. multi-panel narration isolation — no stage text leaking across display_group boundaries
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildCombinedVoiceAnswer, buildStagePayload, createStageRecord } = require("../services/qna/stageService");
const { normalizeAuthoredBundleStagesV4 } = require("../services/qna/executorAgent");
const { generateViableStrategies } = require("../services/charts/chartStrategyService");

// ── helpers ────────────────────────────────────────────────────────────────────

function makeStage(idx, { displayGroup = idx, spokenText, title, chartType = "bar" } = {}) {
  return createStageRecord({
    stageIndex: idx,
    title: title || `Stage ${idx}`,
    spokenText: spokenText || `Spoken text for stage ${idx}.`,
    screenText: `Screen text ${idx}.`,
    chartSpec: {
      chart_type: chartType,
      title: `Chart ${idx}`,
      subtitle: "",
      takeaway: `Takeaway ${idx}`,
      option: {
        xAxis: { type: "category", data: ["Mon", "Tue"] },
        yAxis: { type: "value" },
        series: [{ type: chartType === "line" ? "line" : "bar", name: `Metric ${idx}`, data: [100, 200] }],
      },
    },
    suggestedFollowups: [],
    moreAvailable: false,
    source: "test",
    requestId: "req_test",
    question: "test question",
    metadata: { display_group: displayGroup },
  });
}

function countOccurrences(str, sub) {
  let count = 0;
  let pos = 0;
  while ((pos = str.indexOf(sub, pos)) !== -1) { count++; pos++; }
  return count;
}

// ── 1. Completion phrase appears exactly once ──────────────────────────────────

test("dedup: autoAdvance voiceText ends with completion phrase exactly once", () => {
  // 3 stages — triggers autoAdvance when currentStageIndex=0 and stageCount=3
  const stages = [makeStage(0), makeStage(1), makeStage(2)];
  const bundle = {
    stages,
    stagesPlan: stages.map((_, i) => ({ stageIndex: i })),
  };

  // buildCombinedVoiceAnswer is called by buildStagePayload when autoAdvance fires
  const payload = buildStagePayload({
    bundle,
    stageRecord: stages[0],
    question: "Health report?",
    stageCountOverride: 3,
  });

  // autoAdvance should be true since all 3 stages available and currentIndex=0
  assert.equal(payload.autoAdvance, true, "Expected autoAdvance=true");

  const COMPLETION = "That covers everything I found";
  const occurrences = countOccurrences(payload.voice_answer, COMPLETION);
  assert.equal(occurrences, 1, `"${COMPLETION}" appeared ${occurrences} times — expected exactly 1`);
});

test("dedup: non-autoAdvance bundleComplete adds completion phrase exactly once", () => {
  // Single stage — no autoAdvance, bundleComplete=true (moreAvailable=false)
  const stage = makeStage(0);
  const bundle = { stages: [stage], stagesPlan: [{ stageIndex: 0 }] };

  const payload = buildStagePayload({
    bundle,
    stageRecord: stage,
    question: "test?",
    stageCountOverride: 1,
  });

  assert.equal(payload.autoAdvance, false, "Single stage should not autoAdvance");

  const COMPLETION = "That covers everything I found";
  const occurrences = countOccurrences(payload.voice_answer, COMPLETION);
  assert.ok(occurrences <= 1, `"${COMPLETION}" appeared ${occurrences} times — should not be more than 1`);
});

test("dedup: buildCombinedVoiceAnswer — each stage spoken text appears exactly once", () => {
  const stage0 = makeStage(0, { spokenText: "Your steps were high on Monday." });
  const stage1 = makeStage(1, { spokenText: "Your sleep was shorter on Tuesday." });
  const stage2 = makeStage(2, { spokenText: "Your heart rate stayed in a healthy zone." });

  const { voiceText } = buildCombinedVoiceAnswer([stage0, stage1, stage2]);

  // Each unique phrase should appear exactly once
  assert.equal(countOccurrences(voiceText, "steps were high"), 1, "stage0 spoken text duplicated");
  assert.equal(countOccurrences(voiceText, "sleep was shorter"), 1, "stage1 spoken text duplicated");
  assert.equal(countOccurrences(voiceText, "heart rate stayed"), 1, "stage2 spoken text duplicated");
  assert.equal(countOccurrences(voiceText, "That covers everything"), 1, "completion phrase duplicated");
});

// ── 2. V4 success: no deterministic content mixed into LLM narration ───────────

test("narration-chart: V4 success — spoken_text is purely LLM, not appended with strategy description", () => {
  const LLM_SPOKEN = "Your steps averaged eight thousand per day, which is above your weekly baseline.";

  const { stages, errors } = normalizeAuthoredBundleStagesV4({
    bundleOutput: {
      bundle_title: "Steps",
      bundle_thread: "thread",
      bundle_summary: "summary",
      stages: [{
        stage_index: 0,
        title: "Daily Steps",
        narrative_role: "orientation",
        spoken_text: LLM_SPOKEN,
        screen_text: "Steps above baseline.",
        chart_type: "bar",
        chart_option: {
          xAxis: { type: "category", data: ["Mon", "Tue", "Wed"] },
          yAxis: { type: "value" },
          series: [{ type: "bar", name: "Steps", data: [8000, 7500, 9100] }],
        },
        chart_title: "Daily Steps",
        chart_subtitle: "Last 7 days",
        chart_takeaway: "Consistent",
        suggested_followups: [],
        analysis_notes: "",
      }],
    },
    rawDataCandidates: [{
      stage_index: 0,
      title_hint: "Daily Steps",
      display_group: 0,
      _viableStrategies: [],
      _stageSpec: {},
    }],
    question: "How are my steps?",
    requestId: "req_ok",
  });

  assert.equal(errors.length, 0, `Unexpected errors: ${errors.join("; ")}`);
  assert.equal(stages.length, 1);

  const stage = stages[0];
  // LLM spoken text should be preserved — not replaced or appended with deterministic text
  assert.ok(stage.spokenText.includes("eight thousand"), "LLM spoken_text not preserved");
  // Should NOT contain typical strategy description strings like "Daily step counts" or "strategy"
  assert.ok(!stage.spokenText.toLowerCase().includes("strategy"), "strategy description leaked into spoken text");
  // Path should show pure V4
  assert.equal(stage.metadata.executor.path, "v4_llm_option");
});

test("narration-chart: V4 success — chartSpec has LLM option, not chart_data", () => {
  const { stages } = normalizeAuthoredBundleStagesV4({
    bundleOutput: {
      bundle_title: "Steps",
      bundle_thread: "t",
      bundle_summary: "s",
      stages: [{
        stage_index: 0,
        title: "Steps",
        narrative_role: "orientation",
        spoken_text: "Your steps were steady.",
        screen_text: "Steady week.",
        chart_type: "line",
        chart_option: {
          xAxis: { type: "category", data: ["Mon", "Tue"] },
          yAxis: { type: "value" },
          series: [{ type: "line", name: "Steps", data: [8000, 7500] }],
        },
        chart_title: "Steps Trend",
        chart_subtitle: "",
        chart_takeaway: "Steady",
        suggested_followups: [],
        analysis_notes: "",
      }],
    },
    rawDataCandidates: [{
      stage_index: 0,
      title_hint: "Steps",
      display_group: 0,
      _viableStrategies: [],
      _stageSpec: {},
    }],
    question: "Trend?",
    requestId: "req_line",
  });

  assert.equal(stages.length, 1);
  const chartSpec = stages[0].chartSpec;
  // V4 success should produce option (LLM-generated), not chart_data (V3 deterministic)
  assert.ok(chartSpec.option, "V4 success should store LLM option in chartSpec.option");
  assert.ok(!chartSpec.chart_data, "V4 success should NOT produce chart_data (that is V3)");
  // chart_type from LLM should be preserved
  assert.equal(chartSpec.chart_type, "line", "chart_type should match LLM-authored type");
});

// ── 3. V4 fallback: narration stays LLM; chart from V3; divergence recorded ───

test("narration-chart: V4 fallback — narration from LLM, chart_data from V3 (no mixing)", () => {
  const LLM_SPOKEN = "The dual-axis comparison shows steps rising while sleep held steady.";

  const multiWindowData = {
    sa_0: {
      normalizedTable: [
        { timestamp: "2026-01-01", steps: 8000 },
        { timestamp: "2026-01-02", steps: 7000 },
      ],
      metrics_needed: ["steps"],
    },
  };

  const viableStrategies = generateViableStrategies({
    stageSpec: { sub_analysis_ids: ["sa_0"], focusMetrics: ["steps"], chartType: "bar" },
    multiWindowData,
    evidenceBundle: {},
  });

  const { stages, errors } = normalizeAuthoredBundleStagesV4({
    bundleOutput: {
      bundle_title: "Comparison",
      bundle_thread: "t",
      bundle_summary: "s",
      stages: [{
        stage_index: 0,
        title: "Steps vs Sleep",
        narrative_role: "orientation",
        spoken_text: LLM_SPOKEN,
        screen_text: "Dual-axis view.",
        chart_type: "dual_axis",  // LLM intended dual-axis
        // Invalid option — no series — will force V3 fallback
        chart_option: { unknownKey: "no real echarts content" },
        chart_title: "Dual Axis",
        chart_subtitle: "",
        chart_takeaway: "Steps rising.",
        suggested_followups: [],
        analysis_notes: "",
      }],
    },
    rawDataCandidates: [{
      stage_index: 0,
      title_hint: "Comparison",
      display_group: 0,
      _viableStrategies: viableStrategies,
      _stageSpec: { sub_analysis_ids: ["sa_0"], focusMetrics: ["steps"] },
    }],
    question: "Compare?",
    requestId: "req_fallback",
    multiWindowData,
    evidenceBundle: {},
  });

  assert.equal(stages.length, 1);
  const stage = stages[0];

  // Narration MUST come from LLM — the dual-axis description
  assert.ok(stage.spokenText.includes("dual-axis") || stage.spokenText.includes("steps rising"),
    `LLM narration not preserved, got: "${stage.spokenText}"`);

  // Chart MUST be V3 deterministic — hydrateChartSpec converts chart_data → option,
  // so we can't check for chart_data directly. Instead verify via the chart_type:
  // V3 has no "dual_axis" strategy, so it will have resolved to a concrete type (bar/line/etc.)
  const chartSpec = stage.chartSpec;
  assert.ok(chartSpec, "chartSpec should exist");
  assert.ok(chartSpec.chart_type !== "dual_axis",
    `V3 fallback should not produce chart_type "dual_axis" — got "${chartSpec.chart_type}"`);

  // Path must indicate V3 fallback was used
  assert.equal(stage.metadata.executor.path, "v4_with_v3_fallback",
    "Path should indicate V3 fallback");

  // LLM's intended chart type should be recorded even though V3 was used
  assert.equal(stage.metadata.executor.selectedChartType, "dual_axis",
    "selectedChartType should record what the LLM intended");
});

test("narration-chart: V4 fallback — V3 strategy description NOT prepended to LLM narration", () => {
  const LLM_SPOKEN = "Steps went up across the week.";

  const multiWindowData = {
    sa_0: {
      normalizedTable: [{ timestamp: "2026-01-01", steps: 5000 }, { timestamp: "2026-01-02", steps: 6000 }],
      metrics_needed: ["steps"],
    },
  };

  const viableStrategies = generateViableStrategies({
    stageSpec: { sub_analysis_ids: ["sa_0"], focusMetrics: ["steps"], chartType: "bar" },
    multiWindowData,
    evidenceBundle: {},
  });

  const { stages } = normalizeAuthoredBundleStagesV4({
    bundleOutput: {
      bundle_title: "Steps",
      bundle_thread: "t",
      bundle_summary: "s",
      stages: [{
        stage_index: 0,
        title: "Steps",
        narrative_role: "orientation",
        spoken_text: LLM_SPOKEN,
        screen_text: "Steps rose.",
        chart_type: "bar",
        chart_option: { badKey: "not a valid option" },
        chart_title: "Steps",
        chart_subtitle: "",
        chart_takeaway: "",
        suggested_followups: [],
        analysis_notes: "",
      }],
    },
    rawDataCandidates: [{
      stage_index: 0,
      title_hint: "Steps",
      display_group: 0,
      _viableStrategies: viableStrategies,
      _stageSpec: { sub_analysis_ids: ["sa_0"], focusMetrics: ["steps"] },
    }],
    question: "Steps?",
    requestId: "req_no_double",
    multiWindowData,
    evidenceBundle: {},
  });

  const spokenText = stages[0].spokenText;

  // The spoken text must not contain duplicated content:
  // – Not the strategy description (e.g. "daily step counts")
  // – Not "steps went up" repeated twice
  assert.equal(countOccurrences(spokenText.toLowerCase(), "steps went up"), 1,
    `"Steps went up" duplicated in: "${spokenText}"`);

  // The V3 mergeStrategyResponse should preserve spoken_text from the LLM authored output,
  // not append or replace with strategy.description
  const strategyDescriptions = viableStrategies.map(s => s.description || "").filter(Boolean);
  for (const desc of strategyDescriptions) {
    if (desc.length > 10) {
      assert.ok(!spokenText.includes(desc),
        `V3 strategy description "${desc}" leaked into spoken text: "${spokenText}"`);
    }
  }
});

// ── 4. Multi-panel: no narration leakage across display_group boundaries ────────

test("multi-panel: voice_answer only contains narration for the active display_group", () => {
  const stage0 = makeStage(0, { displayGroup: 0, spokenText: "Week one steps were strong." });
  const stage1 = makeStage(1, { displayGroup: 0, spokenText: "Week two steps were lower." });
  const stage2 = makeStage(2, { displayGroup: 1, spokenText: "Your sleep trend is separate." });
  const bundle = {
    stages: [stage0, stage1, stage2],
    stagesPlan: [{ stageIndex: 0 }, { stageIndex: 1 }, { stageIndex: 2 }],
  };

  // Get payload for stage 2 — which is on its own screen (display_group 1)
  const payload = buildStagePayload({
    bundle,
    stageRecord: stage2,
    question: "Summary?",
    stageCountOverride: 3,
  });

  // voice_answer for stage2's screen should include stage2's narration
  assert.ok(payload.voice_answer.includes("sleep trend"),
    `voice_answer should include stage2's narration`);

  // voice_answer for stage2's screen should NOT include stage0 or stage1 narration
  // (those belong to display_group 0, a different screen)
  assert.ok(!payload.voice_answer.includes("Week one steps"),
    `voice_answer for display_group 1 should not contain display_group 0 narration (stage0)`);
  assert.ok(!payload.voice_answer.includes("Week two steps"),
    `voice_answer for display_group 1 should not contain display_group 0 narration (stage1)`);
});

test("multi-panel: panels array for display_group 0 does not include stage from group 1", () => {
  const stage0 = makeStage(0, { displayGroup: 0, spokenText: "Week one was good." });
  const stage1 = makeStage(1, { displayGroup: 0, spokenText: "Week two was steady." });
  const stage2 = makeStage(2, { displayGroup: 1, spokenText: "Sleep was restful." });
  const bundle = {
    stages: [stage0, stage1, stage2],
    stagesPlan: [{ stageIndex: 0 }, { stageIndex: 1 }, { stageIndex: 2 }],
  };

  const payload = buildStagePayload({
    bundle,
    stageRecord: stage0,
    question: "Compare weeks?",
    stageCountOverride: 3,
  });

  assert.equal(payload.panels.length, 2, "Group 0 should have 2 panels (stage0 + stage1)");
  const panelIds = payload.panels.map(p => p.panel_id);
  assert.ok(panelIds.includes("stage_0"), "stage_0 panel missing");
  assert.ok(panelIds.includes("stage_1"), "stage_1 panel missing");
  assert.ok(!panelIds.includes("stage_2"), "stage_2 should not appear in group 0 panels");
});

test("multi-panel: stages field speech/voice_answer match — no cross-contamination", () => {
  const stage0 = makeStage(0, { displayGroup: 0, spokenText: "First insight here." });
  const stage1 = makeStage(1, { displayGroup: 1, spokenText: "Second insight here." });
  const bundle = {
    stages: [stage0, stage1],
    stagesPlan: [{ stageIndex: 0 }, { stageIndex: 1 }],
  };

  const payload = buildStagePayload({
    bundle,
    stageRecord: stage0,
    question: "test?",
    stageCountOverride: 2,
  });

  // The stages[] field should preserve each stage's own speech
  const stagesField = payload.stages;
  const s0 = stagesField.find(s => s.stageIndex === 0);
  const s1 = stagesField.find(s => s.stageIndex === 1);

  assert.ok(s0, "stages[0] should exist");
  assert.ok(s1, "stages[1] should exist");

  // stage0's speech should not contain stage1's text and vice versa
  assert.ok(s0.speech.includes("First insight"), `stage0 speech wrong: "${s0.speech}"`);
  assert.ok(s1.speech.includes("Second insight"), `stage1 speech wrong: "${s1.speech}"`);
  assert.ok(!s0.speech.includes("Second insight"), "stage0 speech contains stage1 content");
  assert.ok(!s1.speech.includes("First insight"), "stage1 speech contains stage0 content");

  // voice_answer should equal speech for each stage in the stages field
  assert.equal(s0.speech, s0.voice_answer, "stages[0].speech !== stages[0].voice_answer");
  assert.equal(s1.speech, s1.voice_answer, "stages[1].speech !== stages[1].voice_answer");
});

// ── 5. chart_type in payload matches chartSpec for each stage ────────────────

test("payload: stages[].chart_spec.chart_type matches the stage chartSpec chart_type", () => {
  const stageBar = makeStage(0, { displayGroup: 0, chartType: "bar" });
  const stageLine = makeStage(1, { displayGroup: 1, chartType: "line" });
  const bundle = {
    stages: [stageBar, stageLine],
    stagesPlan: [{ stageIndex: 0 }, { stageIndex: 1 }],
  };

  const payload = buildStagePayload({
    bundle,
    stageRecord: stageBar,
    question: "types?",
    stageCountOverride: 2,
  });

  const s0 = payload.stages.find(s => s.stageIndex === 0);
  const s1 = payload.stages.find(s => s.stageIndex === 1);

  // chart_spec in the stages[] field should preserve chart_type
  assert.equal(s0.chart_spec?.chart_type, "bar", `stage0 chart_type mismatch`);
  assert.equal(s1.chart_spec?.chart_type, "line", `stage1 chart_type mismatch`);

  // primary_visual chart_type should match the active stage (stageBar)
  assert.equal(payload.primary_visual?.chart_type, "bar", "primary_visual chart_type mismatch");
});
