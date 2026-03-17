const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyStageProgressionPolicy,
  handleControlWithOrchestrator,
  handleNavigationControl,
  handleQuestionWithOrchestrator,
} = require("../qnaOrchestrator");
const { createStageRecord } = require("../stageService");

function buildStage(stageIndex, title = `Stage ${stageIndex + 1}`) {
  return createStageRecord({
    stageIndex,
    title,
    spokenText: `${title} spoken`,
    screenText: `${title} screen`,
    chartSpec: {
      chart_type: "line",
      title,
      takeaway: `${title} takeaway`,
      option: {
        xAxis: { type: "category", data: ["Mon"] },
        yAxis: { type: "value" },
        series: [{ type: "line", data: [1] }],
      },
    },
    suggestedFollowups: ["Show more"],
    moreAvailable: true,
    source: "executor_stage_test",
  });
}

function buildExecutorResult(bundle, stage) {
  return {
    ok: true,
    stage,
    stageSummary: { stageIndex: stage.stageIndex, title: stage.title },
    bundle: {
      ...bundle,
      currentStageIndex: stage.stageIndex,
      stages: [...(bundle.stages || []), stage],
    },
    payload: {
      answer_ready: true,
      voice_answer_source: "gpt",
      voice_answer: stage.spokenText,
      spoken_answer: stage.spokenText,
      report_title: stage.title,
      activeStageIndex: stage.stageIndex,
    },
    stageGenerator: stage.stageIndex === 0 ? "executor_stage1" : "executor_next_stage",
  };
}

function baseDeps(overrides = {}) {
  return {
    beginRequest: () => ({ ok: true, requestKey: "req_test", concurrentDetected: false }),
    endRequest: () => {},
    setRequestBundleOwnership: () => {},
    setBundleRequestOwnership: async () => null,
    recordSessionAudit: () => null,
    isCurrentRequest: () => true,
    setLatestRequestKey: () => {},
    isMongoReady: () => true,
    getUserContext: async () => ({ user: "amy" }),
    loadActiveBundleForUser: async () => null,
    planQuestion: async () => ({
      mode: "new_analysis",
      metricsNeeded: ["sleep_minutes"],
      timeScope: "last_7_days",
      analysisGoal: "Analyze sleep",
      candidateStageTypes: ["overview"],
    }),
    classifyContinuation: () => ({ decision: "new", reason: "test" }),
    continueExistingBundle: async ({ activeBundle }) => activeBundle,
    branchBundle: async () => {
      throw new Error("branchBundle should not be called in this test");
    },
    startNewBundleFromPlanner: async () => ({
      bundleId: "bundle_new_1",
      question: "How did I sleep?",
      plannerOutput: { mode: "new_analysis", time_scope: "last_7_days" },
      metricsRequested: ["sleep_minutes"],
      stages: [],
      currentStageIndex: 0,
    }),
    setActiveBundleId: () => {},
    setActiveBundleForUser: () => {},
    ensureBundleHasNormalizedData: async ({ bundle }) => bundle,
    tryExecutorStageGeneration: async ({ resolvedBundle }) => buildExecutorResult(resolvedBundle, buildStage(0, "Stage 1")),
    isStaleRequest: () => false,
    getSessionState: () => ({ latestRequestKey: "req_latest" }),
    setSessionStageIndex: () => {},
    shouldGenerateNextStage: () => true,
    getNextStageIndex: () => 1,
    runLegacyStage1: async () => ({
      answerReady: true,
      payload: {
        answer_ready: true,
        voice_answer_source: "fallback",
        voice_answer: "Legacy fallback answer",
        spoken_answer: "Legacy fallback answer",
      },
    }),
    answerFollowupFromPayload: async ({ payload, question }) => ({
      answer: `Follow-up: ${question}`,
      answer_ready: true,
      voice_answer_source: "fallback",
      payload: {
        ...(payload || {}),
        answer_ready: true,
        voice_answer_source: "fallback",
        voice_answer: `Follow-up: ${question}`,
        spoken_answer: `Follow-up: ${question}`,
      },
    }),
    buildLegacyFallbackStage: () => buildStage(1, "Fallback Stage"),
    persistStageResult: async ({ bundle, stageRecord }) => ({
      bundle: { ...bundle, stages: [...(bundle.stages || []), stageRecord] },
      stageRecord,
      stageSummary: { stageIndex: stageRecord.stageIndex, title: stageRecord.title },
    }),
    setBundleStatus: async () => null,
    getActiveBundleId: () => "bundle_nav_1",
    getBundleById: async () => null,
    setRequestedStageIndex: () => {},
    setBundleStageIndex: async (bundleId, stageIndex) => ({ bundleId, currentStageIndex: stageIndex }),
    applyStageReplayState: () => {},
    ...overrides,
  };
}

test("planner new_analysis path creates a new bundle and returns executor stage 1", async () => {
  let newBundleCalls = 0;
  let continueCalls = 0;
  const deps = baseDeps({
    startNewBundleFromPlanner: async () => {
      newBundleCalls += 1;
      return {
        bundleId: "bundle_new_2",
        question: "How did I sleep?",
        plannerOutput: { mode: "new_analysis", time_scope: "last_7_days" },
        metricsRequested: ["sleep_minutes"],
        stages: [],
        currentStageIndex: 0,
      };
    },
    continueExistingBundle: async () => {
      continueCalls += 1;
      return null;
    },
  });

  const result = await handleQuestionWithOrchestrator({
    requestId: "req_new_bundle",
    username: "amy",
    question: "How did I sleep this week?",
    __deps: deps,
  });

  assert.equal(newBundleCalls, 1);
  assert.equal(continueCalls, 0);
  assert.equal(result.orchestrator.bundleAction, "new");
  assert.equal(result.orchestrator.stageGenerator, "executor_stage1");
  assert.equal(result.bundleId, "bundle_new_2");
});

test("planner continue path reuses active bundle and advances to executor next stage", async () => {
  let continueCalls = 0;
  let newBundleCalls = 0;
  const activeBundle = {
    bundleId: "bundle_continue_1",
    question: "How did I sleep?",
    plannerOutput: { mode: "continue_analysis", time_scope: "last_7_days" },
    metricsRequested: ["sleep_minutes"],
    stages: [buildStage(0, "Stage 1")],
    currentStageIndex: 0,
    executorResponseId: "resp_stage_1",
  };

  const deps = baseDeps({
    loadActiveBundleForUser: async () => activeBundle,
    planQuestion: async () => ({
      mode: "continue_analysis",
      metricsNeeded: ["sleep_minutes"],
      timeScope: "last_7_days",
      analysisGoal: "Continue sleep analysis",
      candidateStageTypes: ["comparison"],
    }),
    classifyContinuation: () => ({ decision: "continue", reason: "test_continue" }),
    continueExistingBundle: async () => {
      continueCalls += 1;
      return activeBundle;
    },
    startNewBundleFromPlanner: async () => {
      newBundleCalls += 1;
      return null;
    },
    tryExecutorStageGeneration: async ({ resolvedBundle }) => buildExecutorResult(resolvedBundle, buildStage(1, "Stage 2")),
  });

  const result = await handleQuestionWithOrchestrator({
    requestId: "req_continue_bundle",
    username: "amy",
    question: "show more",
    __deps: deps,
  });

  assert.equal(continueCalls, 1);
  assert.equal(newBundleCalls, 0);
  assert.equal(result.orchestrator.bundleAction, "continue");
  assert.equal(result.orchestrator.stageGenerator, "executor_next_stage");
  assert.equal(result.stage.stageIndex, 1);
});

test("executor timeout falls back to legacy stage generation and persists fallback stage", async () => {
  const activeBundle = {
    bundleId: "bundle_fallback_1",
    question: "How did I sleep?",
    plannerOutput: { mode: "continue_analysis", time_scope: "last_7_days" },
    metricsRequested: ["sleep_minutes"],
    stages: [buildStage(0, "Stage 1")],
    currentStageIndex: 0,
  };

  const deps = baseDeps({
    loadActiveBundleForUser: async () => activeBundle,
    planQuestion: async () => ({
      mode: "continue_analysis",
      metricsNeeded: ["sleep_minutes"],
      timeScope: "last_7_days",
      analysisGoal: "Continue sleep analysis",
      candidateStageTypes: ["comparison"],
    }),
    classifyContinuation: () => ({ decision: "continue", reason: "test_continue" }),
    continueExistingBundle: async () => activeBundle,
    tryExecutorStageGeneration: async () => ({
      ok: false,
      status: "timeout",
      reason: "executor_timeout",
    }),
    buildLegacyFallbackStage: () => buildStage(1, "Legacy Stage 2"),
  });

  const result = await handleQuestionWithOrchestrator({
    requestId: "req_fallback_bundle",
    username: "amy",
    question: "show more",
    __deps: deps,
  });

  assert.equal(result.orchestrator.used, true);
  assert.equal(result.orchestrator.stageGenerator, "legacy_fallback");
  assert.equal(result.orchestrator.fallbackReason, "executor_timeout");
});

test("navigation control replays stored stage without regeneration when stage already exists", async () => {
  let executorCalls = 0;
  const bundle = {
    bundleId: "bundle_nav_1",
    question: "How did I sleep?",
    plannerOutput: { mode: "continue_analysis", time_scope: "last_7_days" },
    metricsRequested: ["sleep_minutes"],
    stages: [buildStage(0, "Stage 1"), buildStage(1, "Stage 2")],
    currentStageIndex: 1,
  };

  const deps = baseDeps({
    getActiveBundleId: () => bundle.bundleId,
    getBundleById: async () => bundle,
    tryExecutorStageGeneration: async () => {
      executorCalls += 1;
      return null;
    },
  });

  const result = await handleNavigationControl({
    username: "amy",
    action: "stage_goto",
    stageIndex: 1,
    requestId: "req_nav_replay",
    __deps: deps,
  });

  assert.equal(result.ok, true);
  assert.equal(result.orchestrator.stageGenerator, "replay_stored_stage");
  assert.equal(result.stage.stageIndex, 1);
  assert.equal(executorCalls, 0);
});

test("navigation control generates a new stage when requested stage is not stored", async () => {
  let executorCalls = 0;
  const bundle = {
    bundleId: "bundle_nav_2",
    question: "How did I sleep?",
    plannerOutput: { mode: "continue_analysis", time_scope: "last_7_days" },
    metricsRequested: ["sleep_minutes"],
    stages: [buildStage(0, "Stage 1"), buildStage(1, "Stage 2")],
    currentStageIndex: 1,
    executorResponseId: "resp_stage_2",
  };

  const deps = baseDeps({
    getActiveBundleId: () => bundle.bundleId,
    getBundleById: async () => bundle,
    tryExecutorStageGeneration: async () => {
      executorCalls += 1;
      const nextStage = buildStage(2, "Stage 3");
      return buildExecutorResult(bundle, nextStage);
    },
  });

  const result = await handleNavigationControl({
    username: "amy",
    action: "stage_next",
    requestId: "req_nav_generate",
    __deps: deps,
  });

  assert.equal(result.ok, true);
  assert.equal(executorCalls, 1);
  assert.equal(result.orchestrator.stageGenerator, "executor_next_stage");
  assert.equal(result.stage.stageIndex, 2);
});

test("question orchestrator applies lambda session hints as non-authoritative hints", async () => {
  const seenStageHints = [];
  const deps = baseDeps({
    setSessionStageIndex: (_username, stageIndex) => {
      seenStageHints.push(stageIndex);
    },
  });

  const result = await handleQuestionWithOrchestrator({
    requestId: "req_hint_question",
    username: "amy",
    question: "How did I sleep?",
    sessionHints: {
      activeStageIndex: 2,
      stageCount: 3,
      pendingAction: "show_more",
      lastQuestion: "How did I sleep?",
    },
    __deps: deps,
  });

  assert.equal(result.answerReady, true);
  assert.equal(result.orchestrator.used, true);
  assert.equal(seenStageHints.includes(2), true);
});

test("control orchestrator maps show_more and back actions to navigation semantics", async () => {
  const bundle = {
    bundleId: "bundle_control_map",
    question: "How did I sleep?",
    plannerOutput: { mode: "continue_analysis", time_scope: "last_7_days" },
    metricsRequested: ["sleep_minutes"],
    stages: [buildStage(0, "Stage 1"), buildStage(1, "Stage 2")],
    currentStageIndex: 1,
    executorResponseId: "resp_stage_2",
  };

  const deps = baseDeps({
    getActiveBundleId: () => bundle.bundleId,
    getBundleById: async () => bundle,
    loadActiveBundleForUser: async () => bundle,
    tryExecutorStageGeneration: async ({ resolvedBundle, explicitStageIndex }) => {
      const target = explicitStageIndex == null ? 2 : explicitStageIndex;
      const nextStage = buildStage(target, `Stage ${target + 1}`);
      return buildExecutorResult(resolvedBundle, nextStage);
    },
  });

  const showMore = await handleControlWithOrchestrator({
    requestId: "req_control_show_more",
    username: "amy",
    action: "show_more",
    sessionHints: { activeStageIndex: 1, stageCount: 2 },
    __deps: deps,
  });
  assert.equal(showMore.ok, true);
  assert.equal(showMore.orchestrator.stageGenerator, "executor_next_stage");

  const back = await handleControlWithOrchestrator({
    requestId: "req_control_back",
    username: "amy",
    action: "back",
    sessionHints: { activeStageIndex: 1, stageCount: 2 },
    __deps: deps,
  });
  assert.equal(back.ok, true);
  assert.equal(back.orchestrator.stageGenerator, "replay_stored_stage");
  assert.equal(back.stage.stageIndex, 0);
});

test("control orchestrator supports compare and explain with lambda-safe payloads", async () => {
  const bundle = {
    bundleId: "bundle_control_followup",
    question: "How did I sleep?",
    plannerOutput: { mode: "continue_analysis", time_scope: "last_7_days" },
    metricsRequested: ["sleep_minutes"],
    stages: [buildStage(0, "Stage 1"), buildStage(1, "Stage 2")],
    currentStageIndex: 1,
    executorResponseId: "resp_stage_2",
  };

  const deps = baseDeps({
    getActiveBundleId: () => bundle.bundleId,
    getBundleById: async () => bundle,
    loadActiveBundleForUser: async () => bundle,
    classifyContinuation: () => ({ decision: "continue", reason: "compare_followup" }),
    continueExistingBundle: async () => bundle,
    tryExecutorStageGeneration: async ({ resolvedBundle }) => {
      const stage = buildStage(2, "Stage 3");
      return buildExecutorResult(resolvedBundle, stage);
    },
    answerFollowupFromPayload: async ({ payload }) => ({
      answer: "Here is what this chart means.",
      answer_ready: true,
      voice_answer_source: "fallback",
      payload: {
        ...(payload || {}),
        answer_ready: true,
        voice_answer_source: "fallback",
        voice_answer: "Here is what this chart means.",
        spoken_answer: "Here is what this chart means.",
      },
    }),
  });

  const compare = await handleControlWithOrchestrator({
    requestId: "req_control_compare",
    username: "amy",
    action: "compare",
    sessionHints: { activeStageIndex: 1, stageCount: 2 },
    __deps: deps,
  });
  assert.equal(compare.ok, true);
  assert.equal(Boolean(compare.payload), true);

  const explain = await handleControlWithOrchestrator({
    requestId: "req_control_explain",
    username: "amy",
    action: "explain",
    sessionHints: { activeStageIndex: 1, stageCount: 2 },
    __deps: deps,
  });
  assert.equal(explain.ok, true);
  assert.equal(Boolean(explain.payload), true);
  assert.equal(explain.orchestrator.controlAction, "explain");
});

test("control orchestrator supports summarize and start_over voice commands", async () => {
  const bundle = {
    bundleId: "bundle_control_summary_startover",
    question: "How did I sleep?",
    plannerOutput: { mode: "continue_analysis", time_scope: "last_7_days" },
    metricsRequested: ["sleep_minutes"],
    stages: [buildStage(0, "Stage 1"), buildStage(1, "Stage 2")],
    currentStageIndex: 1,
    executorResponseId: "resp_stage_2",
  };

  const deps = baseDeps({
    getActiveBundleId: () => bundle.bundleId,
    getBundleById: async () => bundle,
    loadActiveBundleForUser: async () => bundle,
    answerFollowupFromPayload: async ({ payload }) => ({
      answer: "Overall, this stage shows steady progress.",
      answer_ready: true,
      voice_answer_source: "fallback",
      payload: {
        ...(payload || {}),
        answer_ready: true,
        voice_answer_source: "fallback",
        voice_answer: "Overall, this stage shows steady progress.",
        spoken_answer: "Overall, this stage shows steady progress.",
      },
    }),
  });

  const summarize = await handleControlWithOrchestrator({
    requestId: "req_control_summarize",
    username: "amy",
    action: "summarize",
    sessionHints: { activeStageIndex: 1, stageCount: 2 },
    __deps: deps,
  });
  assert.equal(summarize.ok, true);
  assert.equal(Boolean(summarize.payload), true);
  assert.equal(summarize.orchestrator.controlAction, "summarize");

  const startOver = await handleControlWithOrchestrator({
    requestId: "req_control_start_over",
    username: "amy",
    action: "start_over",
    sessionHints: { activeStageIndex: 1, stageCount: 2 },
    __deps: deps,
  });
  assert.equal(startOver.ok, true);
  assert.equal(Boolean(startOver.payload), true);
  assert.equal(startOver.orchestrator.controlAction, "start_over");
});

test("stage progression policy enforces min/max stage continuation behavior", () => {
  const stageOne = applyStageProgressionPolicy({
    ...buildStage(0, "Stage 1"),
    moreAvailable: false,
    suggestedFollowups: ["go back"],
  });
  assert.equal(stageOne.moreAvailable, true);
  assert.equal(stageOne.suggestedFollowups.includes("show more"), true);
  assert.equal(stageOne.suggestedFollowups.includes("yes"), true);

  const stageFour = applyStageProgressionPolicy({
    ...buildStage(3, "Stage 4"),
    moreAvailable: true,
    suggestedFollowups: ["show more", "yes", "go back"],
  });
  assert.equal(stageFour.moreAvailable, false);
  assert.equal(stageFour.suggestedFollowups.includes("show more"), false);
  assert.equal(stageFour.suggestedFollowups.includes("yes"), false);
});

test("navigation returns deterministic terminal response after stage 4 without legacy fallback", async () => {
  const bundle = {
    bundleId: "bundle_nav_terminal",
    question: "How did I sleep?",
    plannerOutput: { mode: "continue_analysis", time_scope: "last_7_days" },
    metricsRequested: ["sleep_minutes"],
    stages: [
      { ...buildStage(0, "Stage 1"), moreAvailable: true },
      { ...buildStage(1, "Stage 2"), moreAvailable: true },
      { ...buildStage(2, "Stage 3"), moreAvailable: true },
      { ...buildStage(3, "Stage 4"), moreAvailable: false },
    ],
    currentStageIndex: 3,
    executorResponseId: "resp_stage_4",
  };

  const deps = baseDeps({
    getActiveBundleId: () => bundle.bundleId,
    getBundleById: async () => bundle,
  });

  const result = await handleNavigationControl({
    username: "amy",
    action: "show_more",
    requestId: "req_nav_terminal",
    __deps: deps,
  });

  assert.equal(result.ok, true);
  assert.equal(result.orchestrator.stageGenerator, "stage_limit_reached");
  assert.match(String(result.voiceAnswer || ""), /last visual/i);
  assert.equal(Boolean(result.payload), true);
  assert.equal(result.payload.answer_ready, true);
});
