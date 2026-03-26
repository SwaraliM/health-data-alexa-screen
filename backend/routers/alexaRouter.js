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
const { buildLambdaResponse } = require("../services/qna/responseBuilder");

const ROUTER_DEBUG = process.env.QNA_ROUTER_DEBUG !== "false";

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

// ── Navigation detection ─────────────────────────────────────────────────────

function normalizeControlAction(rawAction = "") {
  // Strip trailing " null" / " undefined" that Lambda appends when slot is empty
  const cleaned = String(rawAction || "")
    .trim()
    .toLowerCase()
    .replace(/[!?.,]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+(null|undefined)$/, "");

  if (!cleaned) return "";
  if (["stage_next", "next", "next chart", "next please", "show more", "more", "continue", "go on", "yes", "okay", "ok", "sure", "resume"].includes(cleaned)) {
    return "show_more";
  }
  if (["stage_back", "go back", "back", "previous"].includes(cleaned)) {
    return "back";
  }
  if (["start over", "restart", "start_over"].includes(cleaned)) {
    return "start_over";
  }
  if (["compare", "compare that", "compare this"].includes(cleaned)) {
    return "compare";
  }
  if (["go deeper", "go deeper into this", "tell me more"].includes(cleaned)) {
    return "go_deeper";
  }
  if (["explain", "explain that", "explain this", "what does this mean"].includes(cleaned)) {
    return "explain";
  }
  return "";
}

function detectNavigationAction(text) {
  const cleaned = String(text || "").trim().toLowerCase().replace(/[!?.,]+$/g, "").replace(/\s+/g, " ");
  if (!cleaned) return null;
  // Only treat short phrases as navigation (avoid intercepting real questions)
  if (cleaned.split(" ").length > 4) return null;
  const action = normalizeControlAction(cleaned);
  if (["show_more", "back", "start_over", "go_deeper", "explain"].includes(action)) return action;
  return null;
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

async function handleLambdaRequest(req, res) {
  let rawText = sanitizeText(String(req.body || ""), 320, "");

  // Strip "start " prefix the Lambda prepends on first turn
  if (rawText.startsWith("start ")) rawText = rawText.slice(6).trim();
  // Strip "smallTalk question asked:... user query: " context wrapper
  const userQueryMatch = rawText.match(/user query:\s*([\s\S]*)$/);
  if (userQueryMatch) rawText = userQueryMatch[1].trim();

  const isPolling = req.query?.tryAgain === "true";
  const username = "amy";

  function lambdaReply(gptResponse) {
    return res.json({ GPTresponse: gptResponse, smallTalk: "" });
  }

  // ── POLL: Lambda checking if background pipeline has finished ────────────
  if (isPolling) {
    routerLog("lambda", "poll request", { username });
    try {
      const result = await orchestrator.resumePending(username);
      if (result?.answer_ready && result?.payload) {
        emitResultToFrontend(username, result);
        emitStatus(username, "completed", "Your health analysis is ready.", {
          stageCount: Number(result.stageCount || 1),
        });
        return lambdaReply(result.voice_answer || "Your health analysis is ready.");
      }
      return lambdaReply("Still working on that");
    } catch (error) {
      routerError("lambda", "poll failed", error);
      return lambdaReply("Still working on that");
    }
  }

  // ── QUESTION: new health question or natural-language navigation ─────────
  if (!rawText || rawText.length < 2) {
    return lambdaReply("I didn't catch that. Try asking about your health or fitness data.");
  }

  routerLog("lambda", "new question", { username, question: rawText });

  // Navigate screen to /qna with loading state
  emitStageNavigation(username, { loading: true, question: rawText });
  emitStatus(username, "loading", "Gathering your health data...");

  // Start pipeline — also push to screen whenever it finishes (even after Lambda timeout)
  const pipelinePromise = orchestrator.handleQuestion({
    username,
    question: rawText,
    requestSource: "alexa",
  }).catch((error) => {
    routerError("lambda", "pipeline failed", error);
    return null;
  });

  // Background: emit to screen the instant pipeline completes, independent of Lambda
  pipelinePromise.then((result) => {
    if (result?.answer_ready && result?.payload) {
      emitResultToFrontend(username, result);
      emitStatus(username, "completed", "Your health analysis is ready.", {
        stageCount: Number(result.stageCount || 1),
      });
    }
  });

  // Wait up to 5s for pipeline (leaves Lambda time for 1+ polls if needed)
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 5000));
  const result = await Promise.race([pipelinePromise, timeout]);

  if (result?.answer_ready) {
    return lambdaReply(result.voice_answer || "Your health analysis is ready.");
  }
  // Pipeline still running — Lambda will poll with tryAgain=true
  return lambdaReply("Still working on that");
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
