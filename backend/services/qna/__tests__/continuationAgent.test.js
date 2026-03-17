const test = require("node:test");
const assert = require("node:assert/strict");

const {
  analyzeFollowupIntent,
  classifyContinuation,
  parseStageIndexFromQuestion,
} = require("../continuationAgent");

const activeBundleSummary = {
  bundleId: "bundle_followup_1",
  stageCount: 2,
  metricsRequested: ["steps", "sleep_minutes"],
  executorResponseId: "resp_1",
};

test("parseStageIndexFromQuestion supports numeric and ordinal stage references", () => {
  assert.equal(parseStageIndexFromQuestion("show stage 2"), 1);
  assert.equal(parseStageIndexFromQuestion("go to the third stage"), 2);
  assert.equal(parseStageIndexFromQuestion("open stage one"), 0);
  assert.equal(parseStageIndexFromQuestion("show something else"), null);
});

test("analyzeFollowupIntent routes navigation follow-ups to replay/back/next/goto", () => {
  const next = analyzeFollowupIntent({
    question: "show more",
    activeBundleSummary,
    plannerResult: { mode: "continue_analysis" },
  });
  assert.equal(next.intentType, "control_navigation");
  assert.equal(next.action, "stage_next");
  assert.equal(next.requiresGeneration, true);

  const back = analyzeFollowupIntent({
    question: "back",
    activeBundleSummary,
    plannerResult: { mode: "continue_analysis" },
  });
  assert.equal(back.action, "stage_back");
  assert.equal(back.canReplay, true);

  const replay = analyzeFollowupIntent({
    question: "replay that",
    activeBundleSummary,
    plannerResult: { mode: "continue_analysis" },
  });
  assert.equal(replay.action, "stage_replay");
  assert.equal(replay.canReplay, true);

  const gotoStage = analyzeFollowupIntent({
    question: "show stage 2",
    activeBundleSummary,
    plannerResult: { mode: "continue_analysis" },
  });
  assert.equal(gotoStage.action, "stage_goto");
  assert.equal(gotoStage.targetStageIndex, 1);
});

test("analyzeFollowupIntent classifies new and branch follow-ups", () => {
  const startOver = analyzeFollowupIntent({
    question: "start over",
    activeBundleSummary,
    plannerResult: { mode: "continue_analysis" },
  });
  assert.equal(startOver.bundleAction, "new");
  assert.equal(startOver.intentType, "control_navigation");
  assert.equal(startOver.action, "start_over");

  const branch = analyzeFollowupIntent({
    question: "what about sleep now",
    activeBundleSummary: {
      ...activeBundleSummary,
      metricsRequested: ["steps"],
    },
    plannerResult: { mode: "continue_analysis" },
  });
  assert.equal(branch.bundleAction, "branch");
  assert.equal(branch.intentType, "branch_bundle");

  const affectBranch = analyzeFollowupIntent({
    question: "does stress affect that too",
    activeBundleSummary,
    plannerResult: { mode: "continue_analysis" },
  });
  assert.equal(affectBranch.bundleAction, "branch");
});

test("analyzeFollowupIntent maps natural verbal control phrases", () => {
  const explain = analyzeFollowupIntent({
    question: "what does this mean",
    activeBundleSummary,
    plannerResult: { mode: "continue_analysis" },
  });
  assert.equal(explain.intentType, "control_navigation");
  assert.equal(explain.action, "explain");

  const compare = analyzeFollowupIntent({
    question: "compare that",
    activeBundleSummary,
    plannerResult: { mode: "continue_analysis" },
  });
  assert.equal(compare.intentType, "control_navigation");
  assert.equal(compare.action, "compare");

  const summarize = analyzeFollowupIntent({
    question: "summarize this",
    activeBundleSummary,
    plannerResult: { mode: "continue_analysis" },
  });
  assert.equal(summarize.intentType, "control_navigation");
  assert.equal(summarize.action, "summarize");
});

test("classifyContinuation falls back to new when no active bundle exists", () => {
  const result = classifyContinuation({
    question: "show more",
    activeBundleSummary: null,
    plannerResult: { mode: "continue_analysis" },
  });
  assert.equal(result.decision, "new");
  assert.equal(result.reason, "no_active_bundle");
});
