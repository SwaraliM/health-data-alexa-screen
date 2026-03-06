/**
 * backend/routers/alexaRouter.js
 *
 * Alexa question turns use a two-layer response flow:
 * - answerQuestion() returns the best voice answer quickly.
 * - A deterministic chart payload is pushed to the screen immediately.
 * - If richer visuals finish later, they are pushed asynchronously.
 * - Browser-triggered queries can still use full rich-build mode directly.
 */

const express = require("express");
const alexaRouter = express.Router();
require("dotenv").config();

const { getClients } = require("../websocket");
const {
  buildRichQnaPayload,
  answerFollowupFromPayload,
  answerQuestion,
} = require("../services/qnaengine");
const { generateSpeech } = require("../services/ttsService");

const qnaSession = new Map();
const qnaJobs = new Map();

const DEFAULT_VOICE_DEADLINE_MS = Math.max(
  250,
  Number(process.env.QNA_VOICE_DEADLINE_MS || 4300)
);
const RICH_FAILSAFE_MS = Math.max(
  8000,
  Number(process.env.QNA_RICH_FAILSAFE_MS || 25000)
);

const ROUTER_DEBUG = process.env.QNA_ROUTER_DEBUG !== "false";

function routerLog(scope, message, data = null) {
  if (!ROUTER_DEBUG) return;
  if (data === null || data === undefined) {
    console.log(`[AlexaRouter][${scope}] ${message}`);
    return;
  }
  console.log(`[AlexaRouter][${scope}] ${message}`, data);
}

function routerWarn(scope, message, data = null) {
  if (data === null || data === undefined) {
    console.warn(`[AlexaRouter][${scope}] ${message}`);
    return;
  }
  console.warn(`[AlexaRouter][${scope}] ${message}`, data);
}

function routerError(scope, message, error = null) {
  if (!error) {
    console.error(`[AlexaRouter][${scope}] ${message}`);
    return;
  }
  console.error(`[AlexaRouter][${scope}] ${message}`, {
    message: error?.message || String(error),
    stack: error?.stack || null,
  });
}

function keyForUser(username = "") {
  return String(username || "").trim().toLowerCase();
}

function makeRequestKey(username, question) {
  return `${keyForUser(username)}::${String(question || "")
    .trim()
    .toLowerCase()}::${Date.now()}`;
}

function emitToScreen(username, message) {
  const socket = getClients().get(keyForUser(username));
  if (!socket) {
    routerWarn("websocket", "no active websocket client for user", {
      username: keyForUser(username),
      action: message?.action,
    });
    return;
  }

  try {
    socket.send(JSON.stringify(message));
  } catch (error) {
    routerError("websocket", "websocket send failed", error);
  }
}

function storeSession(username, built, extra = {}) {
  const sessionValue = {
    payload: built?.payload || null,
    rawData: built?.rawData || null,
    userContext: built?.userContext || null,
    planner: built?.planner || null,
    updatedAt: Date.now(),
    requestKey: extra.requestKey || null,
  };

  qnaSession.set(keyForUser(username), sessionValue);

  routerLog("session", "session stored", {
    username: keyForUser(username),
    requestKey: sessionValue.requestKey,
    stageCount: sessionValue?.payload?.stageCount || 0,
    question: sessionValue?.payload?.question || null,
  });
}

function getSession(username) {
  return qnaSession.get(keyForUser(username)) || null;
}

function getActiveStage(payload) {
  const stages = Array.isArray(payload?.stages) ? payload.stages : [];
  const idx = Math.max(
    0,
    Math.min(Number(payload?.activeStageIndex || 0), Math.max(0, stages.length - 1))
  );

  return {
    index: idx,
    stage: stages[idx] || null,
    stages,
  };
}

function emitQnaPayload(username, payload, opts = {}) {
  const action = opts.action || "navigation";

  emitToScreen(username, {
    action,
    option: "/qna",
    data: payload,
  });

  const { stage, index } = getActiveStage(payload);
  if (!stage) return;

  emitToScreen(username, {
    action: "qnaStageSet",
    stageIndex: index,
    cue: stage.cue || stage?.chart_spec?.title || "",
    speech: stage.voice_answer || payload?.voice_answer || "",
    data: payload,
  });

  routerLog("screen", "QnA payload emitted", {
    username: keyForUser(username),
    action,
    stageIndex: index,
    title: stage?.chart_spec?.title || null,
    stageCount: payload?.stageCount || 0,
  });
}

function emitAnswerReady(username, payload) {
  emitToScreen(username, {
    action: "status",
    type: "ready",
    message: "Your answer is ready.",
    suggestion:
      payload?.suggested_follow_up?.[0] ||
      "Say explain that for more detail.",
  });

  routerLog("screen", "answer-ready status emitted", {
    username: keyForUser(username),
    suggestion:
      payload?.suggested_follow_up?.[0] ||
      "Say explain that for more detail.",
  });
}

function stageSpeech(stage, payload) {
  return (
    stage?.voice_answer ||
    stage?.speech ||
    payload?.voice_answer ||
    "Here is your summary."
  );
}

function startRichBuild(username, question, opts = {}) {
  const jobKey = `${keyForUser(username)}::${String(question || "")
    .trim()
    .toLowerCase()}`;
  const existing = qnaJobs.get(jobKey);
  if (existing) {
    routerLog("jobs", "reusing existing rich-build job", {
      username: keyForUser(username),
      jobKey,
    });
    return existing;
  }

  routerLog("jobs", "starting rich-build job", {
    username: keyForUser(username),
    question,
    opts,
  });

  const job = buildRichQnaPayload({
    username,
    question,
    allowFetchPlannerLLM: true,
    allowPresenterLLM: true,
    presentTimeoutMs: RICH_FAILSAFE_MS,
    ...opts,
  })
    .then((built) => {
      storeSession(username, built, {
        requestKey: makeRequestKey(username, question),
      });
      emitQnaPayload(username, built.payload, { action: "navigation" });
      return built;
    })
    .finally(() => {
      qnaJobs.delete(jobKey);
    });

  qnaJobs.set(jobKey, job);
  return job;
}

function maybePreserveActiveStage(currentPayload, nextPayload) {
  const currentIndex = Number(currentPayload?.activeStageIndex || 0);
  const nextStageCount = Array.isArray(nextPayload?.stages)
    ? nextPayload.stages.length
    : 0;

  if (!nextStageCount) {
    nextPayload.activeStageIndex = 0;
    return nextPayload;
  }

  nextPayload.activeStageIndex = Math.max(
    0,
    Math.min(currentIndex, nextStageCount - 1)
  );

  return nextPayload;
}

function attachVisualContinuation({
  username,
  question,
  requestKey,
  deterministicResult,
}) {
  const visualPromise = deterministicResult?.visualContinuationPromise;
  if (!visualPromise || typeof visualPromise.then !== "function") {
    routerLog("continuation", "no visual continuation promise available", {
      username: keyForUser(username),
      question,
    });
    return;
  }

  routerLog("continuation", "attaching visual continuation listener", {
    username: keyForUser(username),
    question,
    requestKey,
  });

  visualPromise
    .then((richPayload) => {
      const currentSession = getSession(username);

      if (!currentSession) {
        routerWarn("continuation", "session missing when rich visuals resolved", {
          username: keyForUser(username),
          question,
        });
        return;
      }

      if (currentSession.requestKey !== requestKey) {
        routerWarn("continuation", "discarding stale rich visual payload", {
          username: keyForUser(username),
          question,
          requestKey,
          currentRequestKey: currentSession.requestKey,
        });
        return;
      }

      const mergedPayload = maybePreserveActiveStage(
        currentSession.payload,
        richPayload
      );

      storeSession(
        username,
        {
          payload: mergedPayload,
          rawData: deterministicResult.rawData,
          userContext: deterministicResult.userContext,
          planner: deterministicResult.planner,
        },
        { requestKey }
      );

      emitAnswerReady(username, mergedPayload);
      emitQnaPayload(username, mergedPayload, { action: "updateVisuals" });

      routerLog("continuation", "rich visual payload applied", {
        username: keyForUser(username),
        question,
        requestKey,
        stageCount: mergedPayload?.stageCount || 0,
      });
    })
    .catch((error) => {
      routerError("continuation", "rich visual continuation failed", error);
    });
}

alexaRouter.post("/tts", async (req, res) => {
  try {
    const text = req.body?.text;
    if (!text || typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "text is required" });
    }

    const audio = await generateSpeech(text.trim());
    return res.json({ audio });
  } catch (error) {
    routerError("tts", "TTS failed", error);
    return res.status(500).json({ error: error.message || "TTS failed" });
  }
});

alexaRouter.post("/browser-query", async (req, res) => {
  const username = keyForUser(req.body?.username || "amy");
  const question = String(req.body?.question || "").trim();

  if (!question) {
    return res.status(400).json({ ok: false, error: "question is required" });
  }

  res.status(200).json({ ok: true });

  emitToScreen(username, {
    action: "status",
    type: "loading",
    message: "Building your chart...",
  });

  try {
    await startRichBuild(username, question);
  } catch (error) {
    routerError("browser-query", "browser query failed", error);
    emitToScreen(username, {
      action: "status",
      type: "error",
      message: "I could not build that chart. Please try a simpler question.",
    });
  }
});

alexaRouter.post("/qna-follow-up", async (req, res) => {
  const username = keyForUser(req.body?.username || "amy");
  const question = String(req.body?.question || "").trim();

  if (!question) {
    return res.status(400).json({
      answer: "",
      suggestions: [],
      error: "question is required",
    });
  }

  const session = getSession(username);
  if (!session?.payload) {
    return res.status(200).json({
      answer: "I am still preparing the chart. Please check the screen in a moment.",
      suggestions: ["How did I sleep this week?"],
    });
  }

  try {
    const result = await answerFollowupFromPayload({
      payload: session.payload,
      question,
    });

    return res.status(200).json({
      answer: result.answer,
      suggestions: result.suggestedQuestions,
    });
  } catch (error) {
    routerError("followup", "follow-up answer failed", error);
    return res.status(200).json({
      answer: "Sorry, I had trouble answering that follow-up.",
      suggestions: session?.payload?.suggested_follow_up || [],
    });
  }
});

async function handleQuestion(username, userInput, res) {
  const question = String(userInput?.text || "").trim();
  const voiceDeadlineMs = Math.max(
    0,
    Number(userInput?.voiceDeadlineMs) || DEFAULT_VOICE_DEADLINE_MS
  );

  if (!question) {
    return res.status(200).json({
      voice_answer: "What would you like to know about your health data?",
      stageCount: 0,
      activeStageIndex: 0,
    });
  }

  const requestKey = makeRequestKey(username, question);

  routerLog("question", "handling Alexa question", {
    username,
    question,
    voiceDeadlineMs,
    requestKey,
  });

  emitToScreen(username, {
    action: "status",
    type: "loading",
    message: "Getting your health data...",
  });

  try {
    const result = await answerQuestion({
      username,
      question,
      voiceDeadlineMs,
      allowFetchPlannerLLM: true,
      allowPresenterLLM: true,
      enableVisualContinuation: true,
    });

    // Push deterministic visuals to the screen immediately.
    storeSession(
      username,
      {
        payload: result.payload,
        rawData: result.rawData,
        userContext: result.userContext,
        planner: result.planner,
      },
      { requestKey }
    );

    emitQnaPayload(username, result.payload, { action: "navigation" });

    // Kick off async richer visuals if available.
    attachVisualContinuation({
      username,
      question,
      requestKey,
      deterministicResult: result,
    });

    return res.status(200).json({
      status: result.status,
      voice_answer:
        result.voiceAnswer ||
        result.payload?.voice_answer ||
        "Here is your summary.",
      stageCount: result.payload?.stageCount || 1,
      activeStageIndex: result.payload?.activeStageIndex || 0,
      suggested_follow_up: result.payload?.suggested_follow_up || [],
    });
  } catch (error) {
    routerError("question", "handleQuestion failed", error);
    return res.status(200).json({
      status: "complete",
      voice_answer: "Sorry, I had trouble getting that. Please try again.",
      stageCount: 0,
      activeStageIndex: 0,
      suggested_follow_up: [],
    });
  }
}

async function handleControl(username, userInput, res) {
  const action = String(userInput?.action || "").toLowerCase();
  const session = getSession(username);

  routerLog("control", "handling control action", {
    username,
    action,
    stageIndex: userInput?.stageIndex,
  });

  if (!session?.payload) {
    return res.status(200).json({
      voice_answer: "I do not have a chart loaded yet. Ask a health question first.",
      stageCount: 0,
      activeStageIndex: 0,
    });
  }

  const payload = session.payload;
  const { stages } = getActiveStage(payload);

  if (action === "show_more" || action === "back") {
    const currentIndex = Number(payload.activeStageIndex || 0);
    const requestedIndex = Number(userInput?.stageIndex);
    let nextIndex = currentIndex;

    if (Number.isFinite(requestedIndex)) {
      nextIndex = Math.max(0, Math.min(requestedIndex, stages.length - 1));
    } else if (action === "show_more") {
      nextIndex = Math.min(currentIndex + 1, stages.length - 1);
    } else {
      nextIndex = Math.max(currentIndex - 1, 0);
    }

    payload.activeStageIndex = nextIndex;
    qnaSession.set(username, session);

    const active = stages[nextIndex];
    emitToScreen(username, {
      action: "qnaStageSet",
      stageIndex: nextIndex,
      cue: active?.cue || active?.chart_spec?.title || "",
      speech: stageSpeech(active, payload),
      data: payload,
    });

    return res.status(200).json({
      voice_answer: stageSpeech(active, payload),
      stageCount: stages.length,
      activeStageIndex: nextIndex,
      status: "complete",
    });
  }

  if (action === "compare") {
    const originalQuestion = payload?.question || "my health data";
    const compareQuestion = /^compare\b/i.test(originalQuestion)
      ? originalQuestion
      : `compare ${originalQuestion}`;

    const built = await buildRichQnaPayload({
      username,
      question: compareQuestion,
      allowFetchPlannerLLM: true,
      allowPresenterLLM: true,
      presentTimeoutMs: RICH_FAILSAFE_MS,
    });

    storeSession(username, built, {
      requestKey: makeRequestKey(username, compareQuestion),
    });
    emitQnaPayload(username, built.payload, { action: "navigation" });

    return res.status(200).json({
      voice_answer: built.payload.voice_answer,
      stageCount: built.payload.stageCount || 1,
      activeStageIndex: 0,
      status: "complete",
    });
  }

  if (action === "explain") {
    const result = await answerFollowupFromPayload({
      payload,
      question: "Explain this chart in plain language.",
    });

    return res.status(200).json({
      voice_answer: result.answer,
      stageCount: stages.length,
      activeStageIndex: payload.activeStageIndex || 0,
      status: "complete",
    });
  }

  return res.status(400).json({
    error: `Unknown control action: ${action}`,
  });
}

alexaRouter.get("/back", (req, res) => {
  const username = keyForUser(req.query?.username || "amy");
  qnaSession.delete(username);

  emitToScreen(username, {
    action: "qnaEnd",
    reason: "user_done",
  });

  routerLog("session", "session cleared", { username });

  return res.status(200).json({ ok: true });
});

alexaRouter.post("/", async (req, res) => {
  const username = keyForUser(req.body?.username || "amy");
  const userInput = req.body?.userInput || {};
  const type = String(userInput?.type || "").toLowerCase();

  routerLog("entry", "incoming Alexa router request", {
    username,
    type,
  });

  if (type === "question") return handleQuestion(username, userInput, res);
  if (type === "control") return handleControl(username, userInput, res);

  return res.status(400).json({
    error: "userInput.type must be 'question' or 'control'",
  });
});

module.exports = alexaRouter;