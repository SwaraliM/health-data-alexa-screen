/**
 * backend/routers/alexaRouter.js
 *
 * Thin router — parses requests, dispatches to orchestrator, returns responses.
 * NO state management. NO polling logic. Single timeout gate.
 *
 * Lambda sends: raw JSON string body + query params (followUp, tryAgain)
 * Lambda expects: { GPTresponse: string, smallTalk: string }
 */

const express = require("express");
const alexaRouter = express.Router();
require("dotenv").config();

const { getClients } = require("../websocket");
const { generateSpeech } = require("../services/ttsService");
const orchestrator = require("../services/qna/qnaOrchestrator");
const {
  detectNavigationAction,
  normalizeControlAction,
  resolveAlexaTurn,
} = require("../services/qna/alexaTurnResolver");

const ROUTER_DEBUG = process.env.QNA_ROUTER_DEBUG !== "false";

// Track timeout count per user for progressive filler messages.
// First timeout → contextual filler. Subsequent timeouts → "still working" message.
const userPollState = new Map();
const userLastDeliveredStage = new Map();

function routerLog(scope, message, data = null) {
  if (!ROUTER_DEBUG) return;
  if (data == null) return console.log(`[AlexaRouter][${scope}] ${message}`);
  console.log(`[AlexaRouter][${scope}] ${message}`, data);
}

function routerError(scope, message, error = null) {
  if (!error) return console.error(`[AlexaRouter][${scope}] ${message}`);
  console.error(`[AlexaRouter][${scope}] ${message}`, {
    message: error?.message || String(error),
  });
}

function keyForUser(username = "") {
  return String(username || "amy").trim().toLowerCase();
}

function sanitizeText(value, max = 800, fallback = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : fallback;
}

function getDeliveryFingerprint(username, result) {
  const requestId = String(result?.requestId || result?.payload?.requestId || "").trim();
  const stageIndex = Number(
    result?.activeStageIndex ?? result?.payload?.activeStageIndex ?? 0
  );
  if (!requestId || !Number.isFinite(stageIndex)) return "";
  return `${keyForUser(username)}:${requestId}:${stageIndex}`;
}

function shouldEmitFrontendStage(username, result, ttlMs = 45000) {
  const userKey = keyForUser(username);
  const fingerprint = getDeliveryFingerprint(userKey, result);
  if (!fingerprint) return true;

  const now = Date.now();
  const prev = userLastDeliveredStage.get(userKey);
  if (prev?.fingerprint === fingerprint && now - Number(prev.timestamp || 0) <= ttlMs) {
    return false;
  }

  userLastDeliveredStage.set(userKey, { fingerprint, timestamp: now });
  return true;
}

// ── WebSocket helpers ────────────────────────────────────────────────────────

function emitToScreen(username, message) {
  const userKey = keyForUser(username);
  const clients = getClients();
  const socket = clients.get(userKey);
  if (!socket) {
    routerLog("websocket", "no active websocket client", { username: userKey });
    return;
  }
  try {
    socket.send(JSON.stringify(message));
  } catch (error) {
    routerError("websocket", "send failed", error);
  }
}

function emitStatus(username, type, message, extra = {}) {
  emitToScreen(username, { action: "status", type, message, ...extra });
}

async function emitDeferredReadyStatus(username, result) {
  if (!result?.answer_ready || !result?.payload) return;

  const requestId = String(result?.requestId || result?.payload?.requestId || "").trim();
  const stageIndex = Number(result?.activeStageIndex ?? result?.payload?.activeStageIndex ?? 0);
  const interaction = await orchestrator.getInteractionState(username);

  // Only announce readiness if this exact request is still waiting to be delivered.
  if (!requestId || interaction?.requestId !== requestId) return;
  if (interaction?.mode !== "ready_to_deliver") return;

  const deliveredFingerprint = String(interaction?.lastDeliveredFingerprint || "").trim();
  const expectedFingerprint = `${requestId}:${Math.max(0, stageIndex)}`;
  if (deliveredFingerprint === expectedFingerprint) return;

  emitStatus(username, "ready_to_resume", "Your answer is ready. Say, Alexa, continue when you're ready to hear it.", {
    requestId,
    activeStageIndex: Math.max(0, stageIndex),
    stageCount: Number(result?.stageCount || result?.payload?.stageCount || 1),
    readyForVoice: true,
  });
}

function emitStageNavigation(username, payload) {
  emitToScreen(username, {
    action: "navigation",
    option: "/qna",
    data: payload,
  });
}

function emitStageSet(username, payload, stageIndex) {
  emitToScreen(username, {
    action: "qnaStageSet",
    data: payload,
    stageIndex,
  });
}

function emitResultToFrontend(username, result) {
  if (!result?.payload) return;
  const stageIndex = Number(result?.activeStageIndex || result?.payload?.activeStageIndex || 0);
  if (stageIndex === 0) {
    emitStageNavigation(username, result.payload);
  } else {
    emitStageSet(username, result.payload, stageIndex);
  }
}

// ── Main route: Lambda compat handler ────────────────────────────────────────

alexaRouter.post("/", async (req, res) => {
  // Lambda sends raw JSON string; structured callers send an object
  if (typeof req.body === "string") {
    try {
      return await handleLambdaRequest(req, res);
    } catch (error) {
      routerError("lambda", "request failed", error);
      return res.status(500).json({ GPTresponse: "I had some trouble. Please try again.", smallTalk: "" });
    }
  }

  // Structured object path (browser / non-Lambda callers)
  const username = keyForUser(req.body?.username || req.body?.userInput?.username || "");
  const userInput = req.body?.userInput || {};
  const type = String(userInput?.type || "question").trim().toLowerCase();

  try {
    if (type === "control") {
      const action = normalizeControlAction(userInput?.action || "");
      if (!action) {
        return res.json({ ok: false, answer_ready: false, voice_answer: "I didn't catch that." });
      }
      const result = await orchestrator.handleNavigation({ username, action, requestId: null });
      if (result?.payload) emitResultToFrontend(username, result);
      return res.json(result);
    }

    // Question or utterance — run through the pipeline
    const questionText = sanitizeText(userInput?.text || userInput?.question || "", 320, "");
    const navAction = detectNavigationAction(questionText);
    if (navAction) {
      const result = await orchestrator.handleNavigation({ username, action: navAction });
      if (result?.payload) emitResultToFrontend(username, result);
      return res.json(result);
    }

    emitStageNavigation(username, { loading: true, question: questionText });
    emitStatus(username, "loading", "Gathering your health data...");

    const result = await orchestrator.handleQuestion({
      username,
      question: questionText,
      requestSource: "browser",
    });

    if (result?.answer_ready && result?.payload) {
      emitResultToFrontend(username, result);
      emitStatus(username, "completed", "Your health analysis is ready.", {
        stageCount: Number(result.stageCount || 1),
      });
    }
    return res.json(result);
  } catch (error) {
    routerError("structured", "request failed", error);
    return res.status(500).json({ ok: false, answer_ready: false, voice_answer: "Something went wrong." });
  }
});

// ── Lambda request handler ───────────────────────────────────────────────────

// Generates context-aware filler statements for Lambda to speak while the pipeline is processing.
// Must be statements not questions — questions would open the mic and interrupt the poll loop.
function getContextualFiller(question) {
  const q = (question || "").toLowerCase();

  const sleepVariants = [
    "Analyzing your sleep stages and overnight heart rate patterns.",
    "Pulling your sleep data for the period you asked about.",
    "Reviewing your sleep depth and any overnight disruptions.",
  ];
  const stepsVariants = [
    "Looking at your activity trends and daily step counts.",
    "Fetching your movement data across the requested period.",
    "Calculating your activity patterns and goal progress.",
  ];
  const heartVariants = [
    "Examining your heart rate trends and variability data.",
    "Pulling your resting heart rate and HRV measurements.",
    "Reviewing your cardiovascular data for the time period.",
  ];
  const genericVariants = [
    "Running the analysis now. Detailed health questions usually take about ten seconds.",
    "Still crunching the numbers. Almost there.",
    "Fetching your health data and building the charts.",
  ];

  let variants;
  if (/sleep|rem|deep|awake|bedtime|wake/.test(q)) {
    variants = sleepVariants;
  } else if (/heart|hrv|bpm|resting|cardio|pulse/.test(q)) {
    variants = heartVariants;
  } else if (/step|walk|active|activity|move|exercise|calorie/.test(q)) {
    variants = stepsVariants;
  } else {
    variants = genericVariants;
  }

  return variants[Math.floor(Date.now() / 1000) % variants.length];
}

async function handleLambdaRequest(req, res) {
  let rawText = sanitizeText(String(req.body || ""), 320, "");

  // Strip "start " prefix the Lambda prepends on first turn
  if (rawText.startsWith("start ")) rawText = rawText.slice(6).trim();
  // Strip "smallTalk question asked:... user query: " context wrapper
  const userQueryMatch = rawText.match(/user query:\s*([\s\S]*)$/);
  if (userQueryMatch) rawText = userQueryMatch[1].trim();

  const isPolling = req.query?.tryAgain === "true";
  const username = "amy";

  function lambdaReply(gptResponse, smallTalk = "") {
    return res.json({ GPTresponse: gptResponse, smallTalk });
  }

  // Helper: push charts + voice together so narration and visuals are always in sync.
  // Alexa gets stage-by-stage delivery with continuation prompts instead of auto-advance.
  async function deliverResult(result, { dedupeFrontendStage = false, turnType = "delivery" } = {}) {
    userPollState.delete(username);
    let voiceForAlexa = result.voice_answer || "Your health analysis is ready.";
    const stageCount = result.stageCount || result.payload?.stageCount || 1;
    const currentIndex = result.activeStageIndex ?? result.payload?.activeStageIndex ?? 0;
    const remaining = stageCount - currentIndex - 1;

    // Override auto-advance: Alexa does stage-by-stage with continuation prompts
    if (result.payload?.autoAdvance && Array.isArray(result.payload?.stages)) {
      const currentStage = result.payload.stages[currentIndex] || result.payload.stages[0];
      voiceForAlexa = currentStage?.speech || currentStage?.voice_answer || voiceForAlexa;
      result.payload.autoAdvance = false;
      result.payload.chartAdvanceSchedule = [];
    }

    // Continuation prompt — tell Echo Dot users to explicitly wake Alexa again.
    // Lambda appends SmallPauseDuration to keep the session open after this.
    if (remaining > 0) {
      voiceForAlexa += " When you're ready for the next chart, say, Alexa, next chart.";
    }
    // else if (stageCount > 1) {
    //   voiceForAlexa += " That covers everything I found. Feel free to ask me another question.";
    // }

    if (!dedupeFrontendStage || shouldEmitFrontendStage(username, result)) {
      emitResultToFrontend(username, result);
    } else {
      routerLog("lambda", "skipping duplicate frontend stage delivery", {
        username,
        requestId: result?.requestId || result?.payload?.requestId || null,
        stageIndex: Number(result?.activeStageIndex ?? result?.payload?.activeStageIndex ?? 0),
      });
    }
    emitStatus(username, "completed", "Your health analysis is ready.", {
      stageCount: Number(result.stageCount || 1),
    });
    await orchestrator.markStageDelivered({
      username,
      requestId: result?.requestId || result?.payload?.requestId || null,
      stageIndex: Number(currentIndex || 0),
      stageCount: Number(stageCount || 1),
      bundleComplete: remaining <= 0,
      turnType,
    });
    return lambdaReply(voiceForAlexa);
  }

  const interaction = await orchestrator.getInteractionState(username);
  const resolvedTurn = resolveAlexaTurn({
    utterance: rawText,
    isPolling,
    interaction,
  });

  routerLog("lambda", "resolved turn", {
    username,
    isPolling,
    utterance: rawText,
    kind: resolvedTurn.kind,
    action: resolvedTurn.action,
    interactionMode: interaction.mode,
  });

  if (resolvedTurn.kind === "cancel_reset") {
    orchestrator.clearRuntimeState(username);
    userPollState.delete(username);
    userLastDeliveredStage.delete(username);
    emitToScreen(username, { action: "qnaEnd", reason: "user_cancelled" });
    return lambdaReply("Okay. I cleared the current health analysis. Ask another health question whenever you're ready.");
  }

  if (resolvedTurn.kind === "navigation") {
    try {
      const result = await orchestrator.handleNavigation({
        username,
        action: resolvedTurn.action,
      });
      if (result?.answer_ready && result?.payload) {
        return deliverResult(result, { turnType: "navigation" });
      }
      return lambdaReply(result?.voice_answer || "I don't have an active analysis. Ask a health question first.");
    } catch (error) {
      routerError("lambda", "navigation failed", error);
      return lambdaReply("I had trouble navigating. Please try again.");
    }
  }

  if (resolvedTurn.kind === "resume_pending" || resolvedTurn.kind === "small_talk_ack" || resolvedTurn.kind === "ignore_chatter") {
    const interactionHasMore = Number(interaction.stageCount || 0) > Number(interaction.currentStageIndex || 0) + 1;
    if (interaction.mode === "complete" && !interactionHasMore && resolvedTurn.action !== "show_more") {
      return lambdaReply("That was the last chart in this analysis. Ask another health question whenever you're ready.");
    }

    if (resolvedTurn.action === "show_more") {
      try {
        const result = await orchestrator.handleNavigation({
          username,
          action: "show_more",
        });
        if (result?.answer_ready && result?.payload) {
          return deliverResult(result, {
            dedupeFrontendStage: true,
            turnType: resolvedTurn.kind,
          });
        }
        return lambdaReply(result?.voice_answer || "I don't have another chart ready yet.");
      } catch (error) {
        routerError("lambda", "continuation delivery failed", error);
        return lambdaReply("I had trouble continuing the analysis. Please try again.");
      }
    }

    try {
      const result = await orchestrator.resumePending(username);
      if (result?.answer_ready && result?.payload) {
        return deliverResult(result, {
          dedupeFrontendStage: true,
          turnType: resolvedTurn.kind,
        });
      }
      const questionSeed = interaction.originalQuestion || rawText;
      const pollState = userPollState.get(username) || { count: 0, question: questionSeed };
      pollState.count += 1;
      pollState.question = pollState.question || questionSeed;
      userPollState.set(username, pollState);
      const fillerText = pollState.count <= 1
        ? getContextualFiller(pollState.question)
        : "Still working on that. Almost there.";
      return lambdaReply("Still working on that", fillerText);
    } catch (error) {
      routerError("lambda", "resume failed", error);
      return lambdaReply("Still working on that", getContextualFiller(interaction.originalQuestion || rawText));
    }
  }

  if (resolvedTurn.kind === "no_active_context_fallback") {
    return lambdaReply("I can help with your health or fitness data. Try asking about sleep, steps, heart rate, or activity trends.");
  }

  if (!rawText || rawText.length < 2) {
    return lambdaReply("I didn't catch that. Try asking about your health or fitness data.");
  }

  routerLog("lambda", "new question", { username, question: rawText });

  emitStageNavigation(username, { loading: true, question: rawText });
  emitStatus(username, "loading", "Gathering your health data...");
  userLastDeliveredStage.delete(username);
  userPollState.set(username, { count: 0, question: rawText });

  const pipelinePromise = orchestrator.handleQuestion({
    username,
    question: rawText,
    requestSource: "alexa",
  }).catch((error) => {
    routerError("lambda", "pipeline failed", error);
    return null;
  });

  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 6500));
  const result = await Promise.race([pipelinePromise, timeout]);

  if (result?.answer_ready) {
    return deliverResult(result, { turnType: "new_health_question" });
  }

  const pollState = userPollState.get(username) || { count: 0, question: rawText };
  pollState.count += 1;
  userPollState.set(username, pollState);

  const fillerText = pollState.count <= 1
    ? getContextualFiller(pollState.question)
    : "Still working on that. Almost there.";

  pipelinePromise
    .then((completedResult) => emitDeferredReadyStatus(username, completedResult))
    .catch((error) => routerError("lambda", "deferred ready status failed", error));

  return lambdaReply("Still working on that", fillerText);
}

// ── Browser query (fire-and-forget, WebSocket delivery) ──────────────────────

alexaRouter.post("/browser-query", async (req, res) => {
  const username = keyForUser(req.body?.username || "amy");
  const question = sanitizeText(req.body?.question, 320, "");

  if (!question) {
    return res.status(400).json({ ok: false, error: "question is required" });
  }

  res.status(200).json({ ok: true });
  emitStatus(username, "loading", "Building your charts...");

  try {
    const result = await orchestrator.handleQuestion({
      username,
      question,
      requestSource: "browser",
    });

    if (result?.answer_ready && result?.payload) {
      // Browser requests use browser TTS — strip Alexa-specific timing schedule
      if (result.payload.chartAdvanceSchedule) {
        result.payload.chartAdvanceSchedule = [];
      }
      emitResultToFrontend(username, result);
      emitStatus(username, "completed", "Your health analysis is ready.", {
        stageCount: Number(result.stageCount || 1),
      });
    } else {
      emitStatus(username, "loading", "The first chart is still preparing...");
    }
  } catch (error) {
    routerError("browser-query", "failed", error);
    emitStatus(username, "error", "I couldn't build that chart. Try rephrasing your question.");
  }
});

// ── TTS ──────────────────────────────────────────────────────────────────────

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

// ── Session clear ────────────────────────────────────────────────────────────

alexaRouter.get("/back", (req, res) => {
  const username = keyForUser(req.query?.username || "amy");
  orchestrator.clearRuntimeState(username);
  emitToScreen(username, { action: "qnaEnd", reason: "user_done" });
  routerLog("session", "session cleared", { username });
  return res.status(200).json({ ok: true });
});

module.exports = alexaRouter;
