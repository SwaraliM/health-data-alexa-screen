const test = require("node:test");
const assert = require("node:assert/strict");

const { runPlannerRequest } = require("../services/openai/plannerClient");
const { runPlannerShadow } = require("../services/qna/qnaOrchestrator");
const { classifyContinuation } = require("../services/qna/continuationAgent");
const { buildStageFromLegacyPayload } = require("../services/qna/stageService");

function withEnv(patch, fn) {
  const previous = {};
  Object.keys(patch).forEach((key) => {
    previous[key] = process.env[key];
    if (patch[key] == null) delete process.env[key];
    else process.env[key] = patch[key];
  });
  const finalize = () => {
    Object.keys(patch).forEach((key) => {
      if (previous[key] == null) delete process.env[key];
      else process.env[key] = previous[key];
    });
  };

  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      return result.finally(finalize);
    }
    finalize();
    return result;
  } catch (error) {
    finalize();
    throw error;
  }
}

test("planner client falls back safely when API key is missing", async () => {
  await withEnv({ OPENAI_API_KEY: null }, async () => {
    const result = await runPlannerRequest({
      question: "How did I sleep this week?",
      activeBundleSummary: null,
      userContext: null,
    });

    assert.equal(typeof result, "object");
    assert.equal(result.mode, "new_analysis");
    assert.equal(typeof result.analysis_goal, "string");
    assert.ok(Array.isArray(result.metrics_needed));
    assert.ok(result.metrics_needed.length >= 1);
    assert.ok(result.metrics_needed.includes("sleep_minutes"));
    assert.ok(Array.isArray(result.candidate_stage_types));
  });
});

test("orchestrator shadow mode skips safely when mongo is not ready", async () => {
  await withEnv({ QNA_PLANNER_SHADOW_MODE: "true" }, async () => {
    const result = await runPlannerShadow({
      username: "amy",
      question: "How many steps did I walk today?",
    });

    assert.equal(typeof result, "object");
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "mongo_not_ready");
  });
});

test("continuation agent maps planner mode and explicit language safely", () => {
  const baseActive = { bundleId: "bundle_123" };

  const continued = classifyContinuation({
    question: "tell me more about that chart",
    activeBundleSummary: baseActive,
    plannerResult: { mode: "continue_analysis" },
  });
  assert.equal(continued.decision, "continue");

  const branched = classifyContinuation({
    question: "instead compare calories versus sleep",
    activeBundleSummary: baseActive,
    plannerResult: { mode: "continue_analysis" },
  });
  assert.equal(branched.decision, "branch");

  const fresh = classifyContinuation({
    question: "start over with a new analysis",
    activeBundleSummary: baseActive,
    plannerResult: { mode: "continue_analysis" },
  });
  assert.equal(fresh.decision, "new");
});

test("stage service wraps legacy payload into stable stage format", () => {
  const stage = buildStageFromLegacyPayload({
    legacyResult: {
      payload: {
        report_title: "Sleep Overview",
        voice_answer: "You slept well this week.",
        summary: { shortText: "Sleep trend looked stable." },
        chart_spec: { chart_type: "line", title: "Sleep Trend" },
        next_views: [{ label: "Sleep detail" }],
      },
    },
    plannerResult: {
      mode: "continue_analysis",
      timeScope: "last_7_days",
      candidateStageTypes: ["overview", "sleep_detail"],
    },
    stageIndex: 0,
    requestId: "req_stage_test",
    question: "How did I sleep?",
  });

  assert.equal(stage.stageIndex, 0);
  assert.equal(stage.title, "Sleep Overview");
  assert.equal(stage.spokenText, "You slept well this week.");
  assert.equal(stage.screenText, "Sleep trend looked stable.");
  assert.equal(stage.source, "legacy_qnaengine_stage1");
  assert.equal(stage.moreAvailable, true);
  assert.ok(Array.isArray(stage.suggestedFollowups));
  assert.ok(stage.chartSpec && stage.chartSpec.chart_type === "line");
});
