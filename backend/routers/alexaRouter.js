/**
 * backend/routers/alexaRouter.js
 *
 * Alexa + browser QnA endpoints.
 *
 * Responsibilities:
 * - Keep the voice path fast for Alexa.
 * - Push chart-first payloads to the screen via WebSocket.
 * - Preserve lightweight stage navigation for "next/previous/repeat".
 */

const express = require("express");
const alexaRouter = express.Router();

require("dotenv").config();

const { getClients } = require("../websocket");
const { buildQnaPayload } = require("../services/qnaEngine");
const { PHIA_QNA_CONFIG } = require("../configs/openAiSystemConfigs");
const { callOpenAIJson } = require("../services/openAIClient");
const { generateSpeech } = require("../services/ttsService");

const INTERNAL_CUTOFF_MS = 6500;
const qnaSession = new Map();

function compressAlexaSpeech(text, fallback = "Here is your quick summary.") {
  const source = String(text || "").trim();
  if (!source) return fallback;
  const firstSentence = source.split(/[.!?]/).map((s) => s.trim()).find(Boolean) || source;
  const words = firstSentence.split(/\s+/).filter(Boolean).slice(0, 22).join(" ");
  if (words.length <= 140) return words;
  return `${words.slice(0, 137).trimEnd()}...`;
}

function makeAlexaResponse(text, { shouldEndSession = false, repromptText = "" } = {}) {
  const response = {
    version: "1.0",
    response: {
      outputSpeech: { type: "PlainText", text: compressAlexaSpeech(text) },
      shouldEndSession,
    },
  };

  if (!shouldEndSession && repromptText) {
    response.response.reprompt = {
      outputSpeech: {
        type: "PlainText",
        text: compressAlexaSpeech(repromptText),
      },
    };
  }

  return response;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function emitToScreen(username, message) {
  const socket = getClients().get(String(username || "").toLowerCase());
  if (!socket) return;
  try {
    socket.send(JSON.stringify(message));
  } catch (error) {
    console.error("WebSocket send failed:", error.message);
  }
}

function getStageAtIndex(payload, rawIndex) {
  const stages = Array.isArray(payload?.stages) && payload.stages.length
    ? payload.stages
    : [{ id: "stage_1", cue: payload?.chart_spec?.title || "Chart", voice_answer: payload?.voice_answer || "", chart_spec: payload?.chart_spec }];

  const index = clamp(Number(rawIndex) || 0, 0, stages.length - 1);
  return { index, stage: stages[index], stages };
}

function emitQnaPayload(username, payload) {
  emitToScreen(username, { action: "navigation", option: "/qna", data: payload });

  const { index, stage } = getStageAtIndex(payload, payload?.activeStageIndex || 0);
  if (!stage) return;

  emitToScreen(username, {
    action: "qnaStageSet",
    stageIndex: index,
    cue: stage.cue || stage?.chart_spec?.title || "",
    speech: stage.voice_answer || payload?.voice_answer || "",
    data: payload,
  });
}

function detectStageCommand(intentName = "", question = "", rawSlotValue = "") {
  const intent = String(intentName || "");
  const utterance = `${String(rawSlotValue || "")} ${String(question || "")}`.toLowerCase().trim();

  if (intent === "AMAZON.StopIntent" || intent === "AMAZON.CancelIntent") return "done";
  if (/\b(done|finish|end|exit|stop|close|go back)\b/.test(utterance)) return "done";
  if (/\b(next|continue|forward|show next)\b/.test(utterance)) return "next";
  if (/\b(previous|back|last one|prior)\b/.test(utterance)) return "previous";
  if (/\b(repeat|again|say that again|replay)\b/.test(utterance)) return "repeat";
  return null;
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
    return res.status(500).json({ error: error.message || "TTS failed" });
  }
});

/**
 * Browser route used by the web/tablet client.
 * Returns quickly; screen updates arrive over WebSocket.
 */
alexaRouter.post("/browser-query", async (req, res) => {
  const username = String(req.body?.username || "amy").trim().toLowerCase();
  const question = String(req.body?.question || "").trim();
  if (!question) return res.status(400).json({ ok: false, error: "question is required" });

  res.status(200).json({ ok: true });

  try {
    const built = await buildQnaPayload({
      username,
      question,
      allowPlannerLLM: true,
      fetchTimeoutMs: 4200,
    });

    qnaSession.set(username, {
      payload: built.payload,
      rawData: built.rawData,
      userContext: built.userContext,
      planner: built.planner,
      updatedAt: Date.now(),
    });

    emitQnaPayload(username, built.payload);
  } catch (error) {
    console.error("browser-query failed:", error.message);
    emitToScreen(username, {
      action: "status",
      type: "error",
      message: "I could not build that chart. Please try a simpler question.",
    });
  }
});

/**
 * Optional follow-up route.
 * Uses stored chart context and does not regenerate charts.
 */
alexaRouter.post("/qna-follow-up", async (req, res) => {
  const username = String(req.body?.username || "amy").trim().toLowerCase();
  const question = String(req.body?.question || "").trim();
  if (!question) return res.status(400).json({ error: "question is required", answer: "", suggestions: [] });

  const session = qnaSession.get(username);
  if (!session?.payload) {
    return res.status(200).json({
      answer: "I am still preparing the chart. Please check the screen in a moment.",
      suggestions: ["How did I sleep this week?"],
    });
  }

  const payload = session.payload;
  const { stage } = getStageAtIndex(payload, payload.activeStageIndex || 0);
  const chartSpec = stage?.chart_spec || payload.chart_spec || {};

  const parsed = await callOpenAIJson({
    systemPrompt: PHIA_QNA_CONFIG.followup.systemPrompt,
    userPayload: {
      chartTitle: chartSpec?.title || "Current chart",
      chartTakeaway: chartSpec?.takeaway || payload?.voice_answer || "",
      chartHighlight: chartSpec?.highlight || null,
      chartContext: payload?.chart_context || null,
      userQuestion: question,
    },
    model: PHIA_QNA_CONFIG.models.followup,
    maxTokens: PHIA_QNA_CONFIG.followup.maxTokens,
    temperature: PHIA_QNA_CONFIG.followup.temperature,
    timeoutMs: 3000,
  });

  const answer = typeof parsed?.answer === "string" && parsed.answer.trim()
    ? parsed.answer.trim()
    : (stage?.voice_answer || payload?.voice_answer || "Here is what I can tell from your chart.");

  const suggestions = Array.isArray(parsed?.suggestedQuestions) && parsed.suggestedQuestions.length
    ? parsed.suggestedQuestions.slice(0, 4)
    : (Array.isArray(chartSpec?.suggested_follow_up) && chartSpec.suggested_follow_up.length
      ? chartSpec.suggested_follow_up.slice(0, 4)
      : Array.isArray(payload?.suggested_follow_up)
        ? payload.suggested_follow_up.slice(0, 4)
        : []);

  return res.status(200).json({ answer, suggestions });
});

/**
 * Alexa skill webhook.
 *
 * Voice response path remains quick; if chart build runs long,
 * Alexa still responds while the screen updates asynchronously.
 */
alexaRouter.post("/", async (req, res) => {
  const isAlexaRequest = req.body?.version && req.body?.request;
  if (!isAlexaRequest) return res.status(400).json({ error: "Expected Alexa request payload." });

  const requestType = req.body.request.type;
  if (requestType === "LaunchRequest") {
    return res.status(200).json(makeAlexaResponse(
      "Welcome to Health Data. Ask about your sleep, steps, heart rate, or calories.",
      { shouldEndSession: false, repromptText: "For example: how did I sleep this week?" }
    ));
  }

  if (requestType !== "IntentRequest") {
    return res.status(200).json(makeAlexaResponse("Sorry, I can only handle questions right now.", { shouldEndSession: true }));
  }

  const intentName = req.body.request.intent?.name || "";
  const username = String(req.body.username || "amy").trim().toLowerCase();
  const slots = req.body.request.intent?.slots || {};
  const rawSlotValue = slots?.question?.value ? String(slots.question.value) : "";
  let question = rawSlotValue.trim();

  if (question) {
    if (intentName === "WhatIntent") question = `What ${question}`;
    else if (intentName === "HowIntent") question = `How ${question}`;
    else if (intentName === "WhenIntent") question = `When ${question}`;
    else if (intentName === "WhyIntent") question = `Why ${question}`;
    else if (intentName === "TellIntent") question = `Tell ${question}`;
  }

  const stageCommand = detectStageCommand(intentName, question, rawSlotValue);
  const session = qnaSession.get(username);

  if (stageCommand === "done") {
    qnaSession.delete(username);
    emitToScreen(username, { action: "qnaEnd", reason: "user_done" });
    return res.status(200).json(makeAlexaResponse("Done. Returning to your dashboard.", { shouldEndSession: true }));
  }

  if (session?.payload && ["next", "previous", "repeat"].includes(stageCommand)) {
    const { stages } = getStageAtIndex(session.payload, session.payload.activeStageIndex || 0);
    if (!stages.length) {
      return res.status(200).json(makeAlexaResponse("I do not have another chart yet. Ask a new health question.", { shouldEndSession: false }));
    }

    const current = Number.isFinite(Number(session.payload.activeStageIndex))
      ? Number(session.payload.activeStageIndex)
      : 0;

    const nextIndex = stageCommand === "next"
      ? clamp(current + 1, 0, stages.length - 1)
      : stageCommand === "previous"
        ? clamp(current - 1, 0, stages.length - 1)
        : current;

    session.payload.activeStageIndex = nextIndex;
    qnaSession.set(username, session);

    const activeStage = stages[nextIndex];
    emitToScreen(username, {
      action: "qnaStageSet",
      stageIndex: nextIndex,
      cue: activeStage?.cue || activeStage?.chart_spec?.title || "",
      speech: activeStage?.voice_answer || session.payload?.voice_answer || "",
      data: session.payload,
    });

    return res.status(200).json(makeAlexaResponse(
      activeStage?.voice_answer || session.payload?.voice_answer || "Here is the chart.",
      { shouldEndSession: false, repromptText: "You can say next, previous, or ask another question." }
    ));
  }

  if (!question) {
    return res.status(200).json(makeAlexaResponse(
      "What would you like to know about your health data?",
      { shouldEndSession: false, repromptText: "For example: how did I sleep this week?" }
    ));
  }

  const buildPromise = buildQnaPayload({
    username,
    question,
    allowPlannerLLM: false,
    fetchTimeoutMs: 2600,
  });

  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => resolve({ _timeout: true }), INTERNAL_CUTOFF_MS);
  });

  const result = await Promise.race([buildPromise, timeoutPromise]);

  if (result && result._timeout) {
    buildPromise
      .then((built) => {
        qnaSession.set(username, {
          payload: built.payload,
          rawData: built.rawData,
          userContext: built.userContext,
          planner: built.planner,
          updatedAt: Date.now(),
        });
        emitQnaPayload(username, built.payload);
      })
      .catch((error) => console.error("Background QnA build failed:", error.message));

    return res.status(200).json(makeAlexaResponse(
      "Okay. I am building that chart now. Please check your screen in a few seconds.",
      { shouldEndSession: false, repromptText: "You can ask another question, or say next when the chart appears." }
    ));
  }

  try {
    const built = result;
    qnaSession.set(username, {
      payload: built.payload,
      rawData: built.rawData,
      userContext: built.userContext,
      planner: built.planner,
      updatedAt: Date.now(),
    });

    emitQnaPayload(username, built.payload);

    return res.status(200).json(makeAlexaResponse(
      built.payload?.voice_answer || "Here is your chart.",
      { shouldEndSession: false, repromptText: "You can say next, previous, or ask another question." }
    ));
  } catch (error) {
    console.error("Alexa QnA handler failed:", error.message);
    return res.status(200).json(makeAlexaResponse(
      "Sorry, I could not load that right now. Please try a simpler question.",
      { shouldEndSession: false, repromptText: "Try: how did I sleep this week?" }
    ));
  }
});

module.exports = alexaRouter;
