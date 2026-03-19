const test = require("node:test");
const assert = require("node:assert/strict");

const routerPath = require.resolve("../routers/alexaRouter");
const orchestratorPath = require.resolve("../services/qna/qnaOrchestrator");
const websocketPath = require.resolve("../websocket");

function createRes() {
  return {
    body: null,
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return payload;
    },
  };
}

function waitForTick(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createPayload({
  voiceAnswer = "Answer ready.",
  source = "gpt",
  stageCount = 1,
  activeStageIndex = 0,
} = {}) {
  return {
    answer_ready: true,
    voice_answer_source: source,
    voice_answer: voiceAnswer,
    spoken_answer: voiceAnswer,
    stageCount,
    activeStageIndex,
    stages: Array.from({ length: stageCount }).map((_, idx) => ({
      id: `stage_${idx}`,
      stageIndex: idx,
      speech: `Stage ${idx + 1}`,
      voice_answer: `Stage ${idx + 1}`,
      summary: `Summary ${idx + 1}`,
      chart_spec: { chart_type: "line", option: { series: [] } },
      title: `Stage ${idx + 1}`,
    })),
    summary: {
      shortSpeech: voiceAnswer,
      shortText: voiceAnswer,
    },
  };
}

function loadRouterWithMocks({
  handleQuestionWithOrchestrator,
  handleControlWithOrchestrator,
} = {}) {
  const originalRouter = require.cache[routerPath];
  const originalOrchestrator = require.cache[orchestratorPath];
  const originalWebsocket = require.cache[websocketPath];

  delete require.cache[routerPath];
  require.cache[orchestratorPath] = {
    id: orchestratorPath,
    filename: orchestratorPath,
    loaded: true,
    exports: {
      handleControlWithOrchestrator: handleControlWithOrchestrator || (async () => ({
        ok: false,
        status: "error",
        reason: "control_not_mocked",
        payload: null,
        voiceAnswer: "Control unavailable",
      })),
      handleNavigationControl: async () => ({
        ok: false,
        status: "error",
        reason: "navigation_not_mocked",
        payload: null,
        voiceAnswer: "Navigation unavailable",
      }),
      handleFollowupWithOrchestrator: async () => ({ payload: null }),
      handleQuestionWithOrchestrator: handleQuestionWithOrchestrator || (async () => ({
        answerReady: true,
        payload: createPayload({ voiceAnswer: "Question answer." }),
      })),
      runPlannerShadow: async () => ({ skipped: true, reason: "test_mock" }),
    },
  };
  require.cache[websocketPath] = {
    id: websocketPath,
    filename: websocketPath,
    loaded: true,
    exports: {
      getClients: () => new Map(),
    },
  };

  const router = require("../routers/alexaRouter");
  return {
    hooks: router._test,
    restore() {
      delete require.cache[routerPath];
      if (originalRouter) require.cache[routerPath] = originalRouter;
      if (originalOrchestrator) require.cache[orchestratorPath] = originalOrchestrator;
      else delete require.cache[orchestratorPath];
      if (originalWebsocket) require.cache[websocketPath] = originalWebsocket;
      else delete require.cache[websocketPath];
    },
  };
}

test("question payload from lambda shape returns lambda-compatible fields", async () => {
  const { hooks, restore } = loadRouterWithMocks({
    handleQuestionWithOrchestrator: async () => ({
      answerReady: true,
      payload: createPayload({
        voiceAnswer: "You averaged 7.2 hours of sleep.",
        stageCount: 1,
        activeStageIndex: 0,
      }),
    }),
  });

  try {
    hooks.resetState();
    const res = createRes();
    await hooks.handleQuestion(
      "amy",
      {
        type: "question",
        text: "How did I sleep this week?",
        inlineWaitMs: 200,
      },
      res,
      { activeStageIndex: 0, stageCount: 1 }
    );

    assert.equal(res.body.status, "complete");
    assert.equal(res.body.voice_answer, "You averaged 7.2 hours of sleep.");
    assert.equal(res.body.stageCount, 1);
    assert.equal(res.body.activeStageIndex, 0);
  } finally {
    restore();
  }
});

test("show_more and back control payloads remain lambda-compatible", async () => {
  const { hooks, restore } = loadRouterWithMocks({
    handleControlWithOrchestrator: async ({ action }) => {
      if (action === "show_more") {
        return {
          ok: true,
          answerReady: true,
          payload: createPayload({
            voiceAnswer: "Here is the next stage.",
            stageCount: 2,
            activeStageIndex: 1,
          }),
          stage: { stageIndex: 1 },
          orchestrator: { stageGenerator: "executor_next_stage" },
        };
      }
      return {
        ok: true,
        answerReady: true,
        payload: createPayload({
          voiceAnswer: "Returning to the previous stage.",
          stageCount: 2,
          activeStageIndex: 0,
        }),
        stage: { stageIndex: 0 },
        orchestrator: { stageGenerator: "replay_stored_stage" },
      };
    },
  });

  try {
    hooks.resetState();

    const showMoreRes = createRes();
    await hooks.handleControl("amy", {
      type: "control",
      action: "show_more",
    }, showMoreRes, { activeStageIndex: 0, stageCount: 1 });

    assert.equal(showMoreRes.body.status, "complete");
    assert.equal(showMoreRes.body.voice_answer, "Here is the next stage.");
    assert.equal(showMoreRes.body.stageCount, 2);
    assert.equal(showMoreRes.body.activeStageIndex, 1);

    const backRes = createRes();
    await hooks.handleControl("amy", {
      type: "control",
      action: "back",
    }, backRes, { activeStageIndex: 1, stageCount: 2 });

    assert.equal(backRes.body.status, "complete");
    assert.equal(backRes.body.voice_answer, "Returning to the previous stage.");
    assert.equal(backRes.body.stageCount, 2);
    assert.equal(backRes.body.activeStageIndex, 0);
  } finally {
    restore();
  }
});

test("compare and explain control actions return lambda-compatible shape", async () => {
  const { hooks, restore } = loadRouterWithMocks({
    handleControlWithOrchestrator: async ({ action }) => {
      if (action === "compare") {
        return {
          ok: true,
          answerReady: true,
          payload: createPayload({
            voiceAnswer: "Your sleep improved compared with last week.",
            stageCount: 3,
            activeStageIndex: 2,
          }),
          stage: { stageIndex: 2 },
          orchestrator: { stageGenerator: "executor_stage_compare" },
        };
      }
      return {
        ok: true,
        answerReady: true,
        payload: createPayload({
          voiceAnswer: "This chart shows your week-over-week sleep trend.",
          stageCount: 3,
          activeStageIndex: 2,
        }),
        stage: { stageIndex: 2 },
        orchestrator: { stageGenerator: "legacy_explain_followup" },
      };
    },
  });

  try {
    hooks.resetState();

    const compareRes = createRes();
    await hooks.handleControl("amy", {
      type: "control",
      action: "compare",
    }, compareRes, { activeStageIndex: 2, stageCount: 3 });

    assert.equal(compareRes.body.status, "complete");
    assert.equal(compareRes.body.voice_answer, "Your sleep improved compared with last week.");
    assert.equal(compareRes.body.stageCount, 3);
    assert.equal(compareRes.body.activeStageIndex, 2);

    const explainRes = createRes();
    await hooks.handleControl("amy", {
      type: "control",
      action: "explain",
    }, explainRes, { activeStageIndex: 2, stageCount: 3 });

    assert.equal(explainRes.body.status, "complete");
    assert.equal(explainRes.body.voice_answer, "This chart shows your week-over-week sleep trend.");
    assert.equal(explainRes.body.stageCount, 3);
    assert.equal(explainRes.body.activeStageIndex, 2);
  } finally {
    restore();
  }
});

test("natural language control aliases map to orchestrator control actions", async () => {
  let seenActions = [];
  const { hooks, restore } = loadRouterWithMocks({
    handleControlWithOrchestrator: async ({ action }) => {
      seenActions.push(action);
      return {
        ok: true,
        answerReady: true,
        payload: createPayload({
          voiceAnswer: "Control alias handled.",
          stageCount: 2,
          activeStageIndex: 1,
        }),
        stage: { stageIndex: 1 },
        orchestrator: { stageGenerator: "executor_next_stage" },
      };
    },
  });

  try {
    hooks.resetState();

    const explainRes = createRes();
    await hooks.handleControl("amy", {
      type: "control",
      action: "what does this mean",
    }, explainRes, { activeStageIndex: 1, stageCount: 2 });

    const restartRes = createRes();
    await hooks.handleControl("amy", {
      type: "control",
      action: "start over",
    }, restartRes, { activeStageIndex: 1, stageCount: 2 });

    assert.equal(explainRes.body.status, "complete");
    assert.equal(restartRes.body.status, "complete");
    assert.equal(seenActions.includes("explain"), true);
    assert.equal(seenActions.includes("start_over"), true);
  } finally {
    restore();
  }
});

test("control fallback still returns valid lambda-compatible response", async () => {
  const { hooks, restore } = loadRouterWithMocks({
    handleControlWithOrchestrator: async () => ({
      ok: false,
      status: "error",
      reason: "executor_timeout",
      payload: null,
      voiceAnswer: "I could not move to that stage yet.",
    }),
  });

  try {
    hooks.resetState();
    const res = createRes();
    await hooks.handleControl("amy", {
      type: "control",
      action: "show_more",
    }, res, { activeStageIndex: 1, stageCount: 2 });

    assert.equal(res.body.status, "partial");
    assert.equal(res.body.voice_answer, "I could not move to that stage yet.");
    assert.equal(res.body.stageCount, 2);
    assert.equal(res.body.activeStageIndex, 1);
  } finally {
    restore();
  }
});

test("replay vs generation keeps stage index semantics stable for lambda", async () => {
  const { hooks, restore } = loadRouterWithMocks({
    handleControlWithOrchestrator: async ({ action }) => {
      if (action === "back") {
        return {
          ok: true,
          answerReady: true,
          payload: createPayload({
            voiceAnswer: "Replaying stage one.",
            stageCount: 3,
            activeStageIndex: 0,
          }),
          stage: { stageIndex: 0 },
          orchestrator: { stageGenerator: "replay_stored_stage" },
        };
      }
      return {
        ok: true,
        answerReady: true,
        payload: createPayload({
          voiceAnswer: "Generating stage three.",
          stageCount: 3,
          activeStageIndex: 2,
        }),
        stage: { stageIndex: 2 },
        orchestrator: { stageGenerator: "executor_next_stage" },
      };
    },
  });

  try {
    hooks.resetState();

    const replayRes = createRes();
    await hooks.handleControl("amy", {
      type: "control",
      action: "back",
    }, replayRes, { activeStageIndex: 1, stageCount: 3 });

    assert.equal(replayRes.body.status, "complete");
    assert.equal(replayRes.body.activeStageIndex, 0);
    assert.equal(replayRes.body.stageCount, 3);

    const generateRes = createRes();
    await hooks.handleControl("amy", {
      type: "control",
      action: "show_more",
    }, generateRes, { activeStageIndex: 1, stageCount: 3 });

    assert.equal(generateRes.body.status, "complete");
    assert.equal(generateRes.body.activeStageIndex, 2);
    assert.equal(generateRes.body.stageCount, 3);
  } finally {
    restore();
  }
});

test("stale concurrent question results do not overwrite newer lambda stage state", async () => {
  let resolveFirst;
  const firstResult = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  let callCount = 0;
  const { hooks, restore } = loadRouterWithMocks({
    handleQuestionWithOrchestrator: async () => {
      callCount += 1;
      if (callCount === 1) return firstResult;
      return {
        answerReady: true,
        payload: createPayload({
          voiceAnswer: "Second request wins.",
          stageCount: 2,
          activeStageIndex: 1,
        }),
        orchestrator: { stageGenerator: "executor_stage1" },
      };
    },
  });

  try {
    hooks.resetState();
    hooks.startQuestionJob({
      username: "amy",
      question: "First question",
      voiceDeadlineMs: 4200,
    });
    const secondJob = hooks.startQuestionJob({
      username: "amy",
      question: "Second question",
      voiceDeadlineMs: 4200,
    });

    await waitForTick(5);
    resolveFirst({
      answerReady: true,
      payload: createPayload({
        voiceAnswer: "Stale first request.",
        stageCount: 1,
        activeStageIndex: 0,
      }),
      orchestrator: { stageGenerator: "executor_stage1" },
    });
    await waitForTick(20);

    const res = createRes();
    await hooks.handleControl("amy", {
      type: "control",
      action: "resume_pending",
    }, res, { activeStageIndex: 1, stageCount: 2 });

    assert.equal(secondJob.status, "ready");
    assert.equal(res.body.status, "complete");
    assert.equal(res.body.voice_answer, "Second request wins.");
    assert.equal(res.body.activeStageIndex, 1);
    assert.equal(res.body.stageCount, 2);
  } finally {
    restore();
  }
});
