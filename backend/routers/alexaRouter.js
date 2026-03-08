/**
 * backend/routers/alexaRouter.js
 *
 * Polling-first Alexa and browser router.
 * - Start jobs immediately
 * - Poll for readiness within the same Alexa turn
 * - Keep async fallback for slower requests
 * - Reuse websocket screen updates and follow-up context
 */

const express = require("express");
const alexaRouter = express.Router();
require("dotenv").config();

const { getClients } = require("../websocket");
const {
  buildRichQnaPayload,
  answerFollowupFromPayload,
  answerQuestion,
} = require("../services/qnaEngine");
const { generateSpeech } = require("../services/ttsService");

const qnaSession = new Map();
const qnaJobs = new Map();

const ROUTER_DEBUG = process.env.QNA_ROUTER_DEBUG !== "false";

function routerLog(scope, message, data = null) {
  if (!ROUTER_DEBUG) return;
  if (data == null) return console.log(`[AlexaRouter][${scope}] ${message}`);
  console.log(`[AlexaRouter][${scope}] ${message}`, data);
}

function routerWarn(scope, message, data = null) {
  if (data == null) return console.warn(`[AlexaRouter][${scope}] ${message}`);
  console.warn(`[AlexaRouter][${scope}] ${message}`, data);
}

function routerError(scope, message, error = null) {
  if (!error) return console.error(`[AlexaRouter][${scope}] ${message}`);
  console.error(`[AlexaRouter][${scope}] ${message}`, {
    message: error?.message || String(error),
    stack: error?.stack || null,
  });
}

function keyForUser(username = "") {
  return String(username || "").trim().toLowerCase();
}

function makeRequestId(username, question) {
  return `${keyForUser(username)}-${Date.now()}-${Buffer.from(String(question || "").slice(0, 24)).toString("hex").slice(0, 12)}`;
}

function emitToScreen(username, message) {
  const userKey = keyForUser(username);
  const clients = getClients();
  const socket = clients.get(userKey);
  if (!socket) {
    routerWarn("websocket", "no active websocket client", {
      username: userKey,
      action: message?.action,
      registeredClients: Array.from(clients.keys()),
    });
    return;
  }
  try {
    routerLog("websocket", "sending websocket message", {
      username: userKey,
      action: message?.action,
      option: message?.option || null,
      registeredClients: Array.from(clients.keys()),
    });
    socket.send(JSON.stringify(message));
  } catch (error) {
    routerError("websocket", "send failed", error);
  }
}

function storeSession(username, payload) {
  const session = {
    payload,
    updatedAt: Date.now(),
  };
  qnaSession.set(keyForUser(username), session);
  return session;
}

function getSession(username) {
  return qnaSession.get(keyForUser(username)) || null;
}

function emitQnaPayload(username, payload, action = "navigation") {
  emitToScreen(username, {
    action,
    option: "/qna",
    data: payload,
  });
}

function emitStatus(username, type, message, extra = {}) {
  emitToScreen(username, {
    action: "status",
    type,
    message,
    ...extra,
  });
}

function serializeJob(job) {
  if (!job) return null;
  const payload = job.result || job.visualPayload || null;
  return {
    requestId: job.requestId,
    status: job.status,
    question: job.question,
    username: job.username,
    payload_ready: Boolean(payload),
    answer_ready: Boolean(payload?.answer_ready),
    voice_answer_source: payload?.voice_answer_source || "bridge",
    voice_answer: payload?.answer_ready ? (payload?.voice_answer || "") : "",
    payload,
    error: job.error || null,
  };
}

/**
 * Launches the backend QnA job immediately so Alexa can poll it.
 */
function startQuestionJob({ username, question, voiceDeadlineMs = 4200 }) {
  const requestId = makeRequestId(username, question);
  const userKey = keyForUser(username);
  const bridgeVoice = "I am analyzing your health data now.";

  const job = {
    requestId,
    username: userKey,
    question,
    status: "pending",
    bridgeVoice,
    result: null,
    visualPayload: null,
    error: null,
    createdAt: Date.now(),
  };

  qnaJobs.set(requestId, job);
  routerLog("jobs", "starting QnA job", { requestId, username: userKey, question });

  emitStatus(userKey, "loading", "Analyzing your health data...");
  emitQnaPayload(userKey, { loading: true, question }, "navigation");

  answerQuestion({
    requestId,
    username: userKey,
    question,
    voiceDeadlineMs,
    allowFetchPlannerLLM: true,
    allowPresenterLLM: true,
    enableVisualContinuation: true,
  })
    .then((result) => {
      job.visualPayload = result.payload || null;
      if (result.payload) {
        storeSession(userKey, result.payload);
        emitQnaPayload(userKey, result.payload, "navigation");
      }

      if (result.answerReady && result.payload?.answer_ready) {
        job.status = "ready";
        job.result = result.payload;
        emitStatus(userKey, "completed", "Your answer is ready.", {
          suggestion: result.payload?.next_views?.[0]?.label || result.payload?.suggestedDrillDowns?.[0] || null,
        });
      } else {
        job.status = "pending";
      }

      const speechReadyPromise = result.speechReadyPromise;
      if (speechReadyPromise && typeof speechReadyPromise.then === "function") {
        speechReadyPromise
          .then((gptPayload) => {
            if (!qnaJobs.has(requestId) || !gptPayload?.answer_ready) return;
            job.status = "ready";
            job.result = gptPayload;
            job.visualPayload = gptPayload;
            storeSession(userKey, gptPayload);
            emitQnaPayload(userKey, gptPayload, "updateVisuals");
            emitStatus(userKey, "completed", "Your answer is ready.", {
              suggestion: gptPayload?.next_views?.[0]?.label || gptPayload?.suggestedDrillDowns?.[0] || null,
            });
          })
          .catch((error) => {
            routerError("jobs", "speech continuation failed", error);
          });
      }

      const continuation = result.visualContinuationPromise;
      if (continuation && typeof continuation.then === "function") {
        continuation
          .then((richPayload) => {
            if (!qnaJobs.has(requestId)) return;
            job.visualPayload = richPayload;
            if (richPayload?.answer_ready) job.result = richPayload;
            storeSession(userKey, richPayload);
            emitQnaPayload(userKey, richPayload, "updateVisuals");
          })
          .catch((error) => {
            routerError("jobs", "rich continuation failed", error);
          });
      }
    })
    .catch((error) => {
      job.status = "error";
      job.error = error?.message || "Unknown error";
      emitStatus(userKey, "error", "I could not complete that request.");
      routerError("jobs", "QnA job failed", error);
    });

  return job;
}

function getJob(requestId) {
  return qnaJobs.get(String(requestId || "").trim()) || null;
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

/**
 * Browser-triggered requests still build the full rich payload and drive the screen.
 */
alexaRouter.post("/browser-query", async (req, res) => {
  const username = keyForUser(req.body?.username || "amy");
  const question = String(req.body?.question || "").trim();
  if (!question) {
    return res.status(400).json({ ok: false, error: "question is required" });
  }

  routerLog("browser-query", "received browser query", {
    username,
    question,
    registeredClients: Array.from(getClients().keys()),
  });

  res.status(200).json({ ok: true });
  emitStatus(username, "loading", "Building your chart...");

  try {
    const requestId = makeRequestId(username, question);
    const built = await buildRichQnaPayload({
      requestId,
      username,
      question,
      allowFetchPlannerLLM: true,
      allowPresenterLLM: true,
    });
    storeSession(username, built.payload);
    emitQnaPayload(username, built.payload, "navigation");
    emitStatus(username, "completed", "Your answer is ready.", {
      suggestion: built.payload?.next_views?.[0]?.label || built.payload?.suggestedDrillDowns?.[0] || null,
    });
  } catch (error) {
    routerError("browser-query", "browser query failed", error);
    emitStatus(username, "error", "I could not build that chart. Please try a simpler question.");
  }
});

alexaRouter.post("/qna-follow-up", async (req, res) => {
  const username = keyForUser(req.body?.username || "amy");
  const question = String(req.body?.question || "").trim();
  const payload = req.body?.payload || getSession(username)?.payload || null;

  if (!question) {
    return res.status(400).json({ answer: "", suggestedQuestions: [], error: "question is required" });
  }
  if (!payload) {
    return res.status(200).json({
      answer: "I do not have enough context yet. Ask a health question first.",
      suggestedQuestions: ["How did I sleep this week?"],
    });
  }

  try {
    const result = await answerFollowupFromPayload({ payload, question });
    if (result?.payload) {
      storeSession(username, result.payload);
      emitQnaPayload(username, result.payload, "updateVisuals");
    }
    return res.status(200).json(result);
  } catch (error) {
    routerError("followup", "follow-up failed", error);
    return res.status(200).json({
      answer: "Sorry, I had trouble answering that follow-up.",
      suggestedQuestions: payload?.suggestedDrillDowns || payload?.suggested_follow_up || [],
    });
  }
});

/**
 * Alexa starts a job and polls this same router for readiness.
 */
async function handleQuestion(username, userInput, res) {
  const question = String(userInput?.text || userInput?.data || "").trim();
  if (!question) {
    return res.status(200).json({
      status: "error",
      voice_answer: "What would you like to know about your health data?",
    });
  }

  const job = startQuestionJob({
    username,
    question,
    voiceDeadlineMs: Number(userInput?.voiceDeadlineMs) || 4200,
  });

  return res.status(200).json({
    status: "pending",
    requestId: job.requestId,
    payload_ready: false,
    answer_ready: false,
    voice_answer_source: "bridge",
    voice_answer: "I am analyzing your health data now.",
  });
}

async function handleControl(username, userInput, res) {
  const action = String(userInput?.action || "").toLowerCase();
  routerLog("control", "handling control action", { username, action, requestId: userInput?.requestId });

  if (action === "poll_pending" || action === "resume_pending") {
    const job = getJob(userInput?.requestId);
    if (!job) {
      return res.status(200).json({
        status: "error",
        payload_ready: false,
        answer_ready: false,
        voice_answer_source: "fallback",
        voice_answer: "I could not find that pending answer. Please ask again.",
      });
    }
    const payload = job.result || job.visualPayload || null;
    if (job.status !== "ready" || !payload?.answer_ready || payload?.voice_answer_source !== "gpt") {
      return res.status(200).json({
        status: job.status,
        requestId: job.requestId,
        payload_ready: Boolean(payload),
        answer_ready: false,
        voice_answer_source: payload?.voice_answer_source || "bridge",
        payload,
        voice_answer: "",
      });
    }
    return res.status(200).json({
      status: "ready",
      requestId: job.requestId,
      payload_ready: true,
      answer_ready: true,
      voice_answer_source: payload.voice_answer_source || "gpt",
      voice_answer: payload.voice_answer || "",
      payload,
    });
  }

  if (action === "job_status") {
    return res.status(200).json(serializeJob(getJob(userInput?.requestId)) || {
      status: "error",
      payload_ready: false,
      answer_ready: false,
      voice_answer_source: "fallback",
      voice_answer: "Request not found.",
    });
  }

  if (action === "accept_suggestion") {
    const session = getSession(username);
    const payload = session?.payload;
    const suggestionId = Number(userInput?.suggestionId || 0);
    const suggestion = payload?.next_views?.[suggestionId]?.label
      || payload?.suggestedDrillDowns?.[suggestionId]
      || payload?.suggested_follow_up?.[suggestionId];
    if (!payload || !suggestion) {
      return res.status(200).json({
        status: "error",
        payload_ready: Boolean(payload),
        answer_ready: false,
        voice_answer_source: "fallback",
        voice_answer: "I do not have a follow-up suggestion ready.",
      });
    }
    const result = await answerFollowupFromPayload({ payload, question: suggestion });
    if (result?.payload) {
      storeSession(username, result.payload);
    }
    return res.status(200).json({
      status: result?.answer_ready ? "ready" : "pending",
      payload_ready: Boolean(result?.payload),
      answer_ready: Boolean(result?.answer_ready),
      voice_answer_source: result?.voice_answer_source || "fallback",
      voice_answer: result?.answer_ready ? result.answer : "",
      suggestedQuestions: result.suggestedQuestions,
      payload: result.payload || payload,
    });
  }

  if (action === "explain") {
    const session = getSession(username);
    if (!session?.payload) {
      return res.status(200).json({
        status: "error",
        payload_ready: false,
        answer_ready: false,
        voice_answer_source: "fallback",
        voice_answer: "There is no chart loaded yet.",
      });
    }
    const result = await answerFollowupFromPayload({
      payload: session.payload,
      question: "Explain this chart.",
    });
    if (result?.payload) {
      storeSession(username, result.payload);
    }
    return res.status(200).json({
      status: result?.answer_ready ? "ready" : "pending",
      payload_ready: Boolean(result?.payload),
      answer_ready: Boolean(result?.answer_ready),
      voice_answer_source: result?.voice_answer_source || "fallback",
      voice_answer: result?.answer_ready ? result.answer : "",
      suggestedQuestions: result.suggestedQuestions,
      payload: result.payload || session.payload,
    });
  }

  return res.status(400).json({ error: `Unknown control action: ${action}` });
}

alexaRouter.get("/back", (req, res) => {
  const username = keyForUser(req.query?.username || "amy");
  qnaSession.delete(username);
  emitToScreen(username, { action: "qnaEnd", reason: "user_done" });
  routerLog("session", "session cleared", { username });
  return res.status(200).json({ ok: true });
});

alexaRouter.post("/", async (req, res) => {
  const username = keyForUser(req.body?.username || "amy");
  const userInput = req.body?.userInput || {};
  const type = String(userInput?.type || "").toLowerCase();

  routerLog("entry", "incoming request", { username, type });

  if (type === "question") return handleQuestion(username, userInput, res);
  if (type === "control") return handleControl(username, userInput, res);
  return res.status(400).json({ error: "userInput.type must be 'question' or 'control'" });
});

module.exports = alexaRouter;
