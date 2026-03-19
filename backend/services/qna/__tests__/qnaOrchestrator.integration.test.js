const test = require("node:test");
const assert = require("node:assert/strict");

const {
  handleFollowupWithOrchestrator,
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
      option: { xAxis: { type: "category", data: ["Mon"] }, yAxis: { type: "value" }, series: [{ type: "line", data: [1] }] },
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
    setLatestRequestKey: () => {},
    setRequestBundleOwnership: () => {},
    setBundleRequestOwnership: async () => null,
    recordSessionAudit: () => null,
    isCurrentRequest: () => true,
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
    branchBundle: async ({ activeBundle }) => activeBundle,
    startNewBundleFromPlanner: async () => ({
      bundleId: "bundle_new_1",
      question: "How did I sleep?",
      plannerOutput: { mode: "new_analysis", time_scope: "last_7_days" },
      metricsRequested: ["sleep_minutes"],
      stages: [],
      currentStageIndex: 0,
    }),
    setActiveBundleForUser: () => {},
    setActiveBundleId: () => {},
    ensureBundleHasNormalizedData: async ({ bundle }) => bundle,
    tryExecutorStageGeneration: async ({ resolvedBundle }) => buildExecutorResult(resolvedBundle, buildStage(0, "Stage 1")),
    getSessionState: () => ({ latestRequestKey: "req_test" }),
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

test("executor success path remains primary under normal flow", async () => {
  const result = await handleQuestionWithOrchestrator({
    requestId: "req_integration_success",
    username: "amy",
    question: "How did I sleep this week?",
    __deps: baseDeps(),
  });

  assert.equal(result.orchestrator.used, true);
  assert.equal(result.orchestrator.stageGenerator, "executor_stage1");
  assert.equal(result.answerReady, true);
});

test("executor timeout keeps legacy fallback path active", async () => {
  const result = await handleQuestionWithOrchestrator({
    requestId: "req_integration_timeout",
    username: "amy",
    question: "How did I sleep this week?",
    __deps: baseDeps({
      tryExecutorStageGeneration: async () => ({
        ok: false,
        status: "timeout",
        reason: "executor_timeout",
      }),
    }),
  });

  assert.equal(result.orchestrator.stageGenerator, "legacy_fallback");
  assert.equal(result.orchestrator.fallbackReason, "executor_timeout");
});

test("stale request protection rejects older async results", async () => {
  const result = await handleQuestionWithOrchestrator({
    requestId: "req_integration_stale",
    username: "amy",
    question: "How did I sleep this week?",
    __deps: baseDeps({
      isCurrentRequest: () => false,
    }),
  });

  assert.equal(result.stale, true);
  assert.equal(result.status, "stale");
  assert.match(String(result.reason || ""), /stale/i);
});

test("follow-up show more generates next stage when missing", async () => {
  let executorCalls = 0;
  const activeBundle = {
    bundleId: "bundle_followup_next",
    question: "How did I sleep?",
    plannerOutput: { mode: "continue_analysis", time_scope: "last_7_days" },
    metricsRequested: ["sleep_minutes"],
    stages: [buildStage(0, "Stage 1")],
    currentStageIndex: 0,
    executorResponseId: "resp_stage_1",
  };

  const result = await handleFollowupWithOrchestrator({
    requestId: "req_followup_next",
    username: "amy",
    question: "show more",
    __deps: baseDeps({
      loadActiveBundleForUser: async () => activeBundle,
      getBundleById: async () => activeBundle,
      getActiveBundleId: () => activeBundle.bundleId,
      classifyContinuation: () => ({ decision: "continue", reason: "explicit_continue" }),
      continueExistingBundle: async () => activeBundle,
      tryExecutorStageGeneration: async () => {
        executorCalls += 1;
        return buildExecutorResult(activeBundle, buildStage(1, "Stage 2"));
      },
    }),
  });

  assert.equal(result.orchestrator.stageGenerator, "executor_next_stage");
  assert.equal(executorCalls, 1);
});

test("follow-up back replays prior stage without regeneration", async () => {
  let executorCalls = 0;
  const activeBundle = {
    bundleId: "bundle_followup_back",
    question: "How did I sleep?",
    plannerOutput: { mode: "continue_analysis", time_scope: "last_7_days" },
    metricsRequested: ["sleep_minutes"],
    stages: [buildStage(0, "Stage 1"), buildStage(1, "Stage 2")],
    currentStageIndex: 1,
    executorResponseId: "resp_stage_2",
  };

  const result = await handleFollowupWithOrchestrator({
    requestId: "req_followup_back",
    username: "amy",
    question: "back",
    __deps: baseDeps({
      loadActiveBundleForUser: async () => activeBundle,
      getBundleById: async () => activeBundle,
      getActiveBundleId: () => activeBundle.bundleId,
      tryExecutorStageGeneration: async () => {
        executorCalls += 1;
        return null;
      },
    }),
  });

  assert.equal(result.orchestrator.stageGenerator, "replay_stored_stage");
  assert.equal(executorCalls, 0);
});

test("follow-up topic shift routes toward branch handling", async () => {
  let branchCalls = 0;
  const activeBundle = {
    bundleId: "bundle_followup_branch",
    question: "How were my steps?",
    plannerOutput: { mode: "continue_analysis", time_scope: "last_7_days" },
    metricsRequested: ["steps"],
    stages: [buildStage(0, "Stage 1")],
    currentStageIndex: 0,
  };

  const result = await handleFollowupWithOrchestrator({
    requestId: "req_followup_branch",
    username: "amy",
    question: "what about sleep now",
    __deps: baseDeps({
      loadActiveBundleForUser: async () => activeBundle,
      planQuestion: async () => ({
        mode: "branch_analysis",
        metricsNeeded: ["sleep_minutes"],
        timeScope: "last_7_days",
        analysisGoal: "Branch to sleep",
        candidateStageTypes: ["comparison"],
      }),
      classifyContinuation: () => ({ decision: "branch", reason: "followup_branch" }),
      branchBundle: async () => {
        branchCalls += 1;
        return {
          ...activeBundle,
          bundleId: "bundle_followup_branch_new",
          metricsRequested: ["sleep_minutes"],
          stages: [],
          currentStageIndex: 0,
        };
      },
      tryExecutorStageGeneration: async ({ resolvedBundle }) => buildExecutorResult(resolvedBundle, buildStage(0, "Branch Stage 1")),
    }),
  });

  assert.equal(branchCalls, 1);
  assert.equal(result.orchestrator.bundleAction, "branch");
  assert.equal(result.orchestrator.followupBundleAction, "branch");
});
