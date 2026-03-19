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

function createPayload(voiceAnswer, source = "gpt") {
  return {
    answer_ready: true,
    voice_answer_source: source,
    voice_answer: voiceAnswer,
    spoken_answer: voiceAnswer,
    stageCount: 1,
    activeStageIndex: 0,
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
        reason: "nav_not_mocked",
        payload: null,
        voiceAnswer: "Navigation unavailable",
      })),
      handleNavigationControl: async () => ({
        ok: false,
        status: "error",
        reason: "nav_not_mocked",
        payload: null,
        voiceAnswer: "Navigation unavailable",
      }),
      handleFollowupWithOrchestrator: async () => ({
        payload: null,
      }),
      handleQuestionWithOrchestrator: handleQuestionWithOrchestrator || (async () => ({
        answerReady: true,
        payload: createPayload("Mock answer", "gpt"),
      })),
      runPlannerShadow: async () => ({
        skipped: true,
        reason: "test_mock",
      }),
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
    router,
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

test("timing-sensitive flow returns usable spoken answer when fallback payload is ready", async () => {
  const { hooks, restore } = loadRouterWithMocks({
    handleQuestionWithOrchestrator: async () => ({
      answerReady: true,
      payload: createPayload("Fallback answer is ready.", "fallback"),
      orchestrator: {
        stageGenerator: "legacy_fallback",
        fallbackReason: "executor_timeout",
      },
    }),
  });

  try {
    hooks.resetState();
    hooks.startQuestionJob({
      username: "amy",
      question: "How did I sleep?",
      voiceDeadlineMs: 4200,
    });
    await waitForTick(5);

    const res = createRes();
    await hooks.handleControl("amy", {
      type: "control",
      action: "resume_pending",
    }, res);

    assert.equal(res.body.status, "complete");
    assert.equal(res.body.answer_ready, true);
    assert.equal(res.body.voice_answer, "Fallback answer is ready.");
    assert.equal(res.body.voice_answer_source, "fallback");
    assert.equal(typeof res.body.stageCount, "number");
    assert.equal(typeof res.body.activeStageIndex, "number");
  } finally {
    restore();
  }
});

test("older async job result is discarded when a newer request becomes active", async () => {
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
        payload: createPayload("Newer answer wins.", "gpt"),
        orchestrator: {
          stageGenerator: "executor_stage1",
        },
      };
    },
  });

  try {
    hooks.resetState();
    const firstJob = hooks.startQuestionJob({
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
      payload: createPayload("Old answer should be ignored.", "gpt"),
      orchestrator: {
        stageGenerator: "executor_stage1",
      },
    });
    await waitForTick(10);

    assert.equal(secondJob.status, "ready");
    assert.equal(secondJob.result?.voice_answer, "Newer answer wins.");
    assert.equal(firstJob.result, null);
  } finally {
    restore();
  }
});

test("navigation control keeps fallback-compatible payload contract", async () => {
  const navPayload = createPayload("Navigation fallback payload", "fallback");
  const { hooks, restore } = loadRouterWithMocks({
    handleControlWithOrchestrator: async () => ({
      ok: true,
      payload: navPayload,
      stage: { stageIndex: 1 },
      orchestrator: {
        used: true,
        stageGenerator: "legacy_navigation_fallback",
        fallbackReason: "executor_navigation_unavailable",
      },
    }),
  });

  try {
    hooks.resetState();
    const res = createRes();
    await hooks.handleControl("amy", {
      type: "control",
      action: "stage_next",
      requestId: "req_nav_1",
    }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, "complete");
    assert.equal(res.body.answer_ready, true);
    assert.equal(res.body.voice_answer_source, "fallback");
    assert.equal(res.body.voice_answer, "Navigation fallback payload");
    assert.equal(typeof res.body.stageCount, "number");
    assert.equal(typeof res.body.activeStageIndex, "number");
  } finally {
    restore();
  }
});
