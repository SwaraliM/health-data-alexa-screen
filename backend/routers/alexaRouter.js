const express = require("express");
const alexaRouter = express.Router();
require("dotenv").config();

const { getClients } = require("../websocket");
const { generateSpeech } = require("../services/ttsService");
const { classifyIntent } = require("../services/qna/intentClassifierService");
const orchestrator = require("../services/qna/qnaOrchestrator");
const { replayStoredStage, getStageByIndex } = require("../services/qna/stageService");
const { getBundleById, loadActiveBundleForUser } = require("../services/qna/bundleService");
const sessionService = require("../services/qna/sessionService");

const ROUTER_DEBUG = process.env.QNA_ROUTER_DEBUG !== "false";
const VOICE_DEADLINE_MS = Math.max(3000, Number(process.env.ALEXA_VOICE_DEADLINE_MS || 4200));
const qnaJobs = new Map();
const resumableJobsByUser = new Map();
const latestQuestionJobByUser = new Map();

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

function sanitizeText(value, max = 320, fallback = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : fallback;
}

function deriveSessionHints(username, explicitHints = null) {
  const session = sessionService.getActiveSessionState(username) || {};
  return {
    activeStageIndex: Number(
      explicitHints?.activeStageIndex != null
        ? explicitHints.activeStageIndex
        : session.currentStageIndex || 0
    ),
    stageCount: Number(explicitHints?.stageCount || 1),
  };
}

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

function getQuestionHandler() {
  if (typeof orchestrator.startQuestionWithOrchestrator === "function") {
    return orchestrator.startQuestionWithOrchestrator;
  }
  if (typeof orchestrator.handleQuestionWithOrchestrator === "function") {
    return orchestrator.handleQuestionWithOrchestrator;
  }
  return null;
}

function getControlHandler() {
  if (typeof orchestrator.handleControlWithOrchestrator === "function") {
    return orchestrator.handleControlWithOrchestrator;
  }
  return null;
}

function getRuntimeClearHandler() {
  return typeof orchestrator.clearRuntimeState === "function"
    ? orchestrator.clearRuntimeState
    : null;
}

function normalizeControlAction(rawAction = "") {
  const normalized = String(rawAction || "")
    .trim()
    .toLowerCase()
    .replace(/[!?.,]+$/g, "")
    .replace(/\s+/g, " ");

  if (!normalized) return "";
  if (["stage_next", "next", "show more", "more", "continue", "go on", "yes", "okay", "ok", "sure"].includes(normalized)) {
    return "show_more";
  }
  if (["stage_back", "go back", "back", "previous"].includes(normalized)) {
    return "back";
  }
  if (["compare", "compare that", "compare this"].includes(normalized)) {
    return "compare";
  }
  if (["go deeper", "go deeper into this", "tell me more"].includes(normalized)) {
    return "go_deeper";
  }
  if (["explain", "explain that", "explain this", "what does this mean", "voice description"].includes(normalized)) {
    return "explain";
  }
  if (["summarize", "summarize this"].includes(normalized)) {
    return "summarize";
  }
  if (["start over", "restart", "start_over"].includes(normalized)) {
    return "start_over";
  }
  if (["resume_pending", "poll_pending"].includes(normalized)) {
    return normalized;
  }
  return normalized;
}

function buildLambdaResponse(result, { defaultStatus = "pending" } = {}) {
  const payload = result?.payload || null;
  const answerReady = result?.answer_ready === true
    || result?.answerReady === true
    || payload?.answer_ready === true;
  const rawStatus = String(result?.status || "").trim().toLowerCase();
  let status = defaultStatus;

  if (answerReady) status = "complete";
  else if (rawStatus === "error") status = "partial";
  else if (rawStatus === "partial") status = "partial";
  else if (rawStatus === "pending") status = defaultStatus;
  else if (rawStatus) status = rawStatus;

  return {
    ok: result?.ok !== false && answerReady,
    status,
    answer_ready: answerReady,
    voice_answer: result?.voice_answer || result?.voiceAnswer || payload?.voice_answer || "",
    voice_answer_source: result?.voice_answer_source || payload?.voice_answer_source || null,
    requestId: result?.requestId || payload?.requestId || null,
    stageCount: Number(result?.stageCount || payload?.stageCount || 1),
    activeStageIndex: Number(result?.activeStageIndex || payload?.activeStageIndex || 0),
    bundle_complete: result?.bundle_complete === true || payload?.bundle_complete === true,
    payload,
  };
}

function buildPendingLambdaResponse({
  result = null,
  requestId = null,
  voiceAnswer = "",
  status = "partial",
  sessionHints = null,
} = {}) {
  const hints = sessionHints || { activeStageIndex: 0, stageCount: 1 };
  return {
    ok: false,
    status,
    answer_ready: false,
    voice_answer: result?.voice_answer || result?.voiceAnswer || voiceAnswer,
    voice_answer_source: result?.voice_answer_source || result?.payload?.voice_answer_source || null,
    requestId: result?.requestId || requestId || null,
    stageCount: Number(result?.stageCount || result?.payload?.stageCount || hints.stageCount || 1),
    activeStageIndex: Number(result?.activeStageIndex || result?.payload?.activeStageIndex || hints.activeStageIndex || 0),
    bundle_complete: false,
    payload: null,
  };
}

function hasReadyPayload(result) {
  return result?.answer_ready === true
    || result?.answerReady === true
    || result?.payload?.answer_ready === true;
}

function emitResultToFrontend(username, result, mode = "question") {
  if (!result?.payload) return;
  const stageIndex = Number(result?.activeStageIndex || result?.payload?.activeStageIndex || 0);
  if (mode === "question" || (mode === "resume" && stageIndex === 0)) {
    emitStageNavigation(username, result.payload);
    return;
  }
  emitStageSet(username, result.payload, stageIndex);
}

function setResumableJob(username, record) {
  const userKey = keyForUser(username);
  if (!record) {
    resumableJobsByUser.delete(userKey);
    return null;
  }
  resumableJobsByUser.set(userKey, { ...record });
  return resumableJobsByUser.get(userKey);
}

function getResumableJob(username) {
  return resumableJobsByUser.get(keyForUser(username)) || null;
}

function clearCompatState(username = null) {
  if (username) {
    const userKey = keyForUser(username);
    resumableJobsByUser.delete(userKey);
    latestQuestionJobByUser.delete(userKey);
    sessionService.clearSessionState(userKey);
    for (const [requestId, job] of qnaJobs.entries()) {
      if (job?.username === userKey) qnaJobs.delete(requestId);
    }
    return;
  }

  for (const userKey of latestQuestionJobByUser.keys()) {
    sessionService.clearSessionState(userKey);
  }
  qnaJobs.clear();
  resumableJobsByUser.clear();
  latestQuestionJobByUser.clear();
}

function startQuestionJob({
  username,
  question,
  requestId = null,
  voiceDeadlineMs = VOICE_DEADLINE_MS,
  sessionHints = null,
  requestSource = "alexa",
} = {}) {
  const userKey = keyForUser(username);
  const safeQuestion = sanitizeText(question, 320, "");
  const safeRequestId = sanitizeText(requestId || "", 120, "") || `req_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const questionHandler = getQuestionHandler();

  const job = {
    requestId: safeRequestId,
    username: userKey,
    question: safeQuestion,
    status: "pending",
    result: null,
    visualPayload: null,
    error: null,
  };
  qnaJobs.set(safeRequestId, job);
  latestQuestionJobByUser.set(userKey, safeRequestId);
  setResumableJob(userKey, {
    requestId: safeRequestId,
    status: "pending",
    delivered: false,
  });

  Promise.resolve()
    .then(async () => {
      if (typeof questionHandler !== "function") {
        throw new Error("question handler unavailable");
      }
      const rawResult = await questionHandler({
        username: userKey,
        question: safeQuestion,
        requestId: safeRequestId,
        requestSource,
        voiceDeadlineMs,
        sessionHints,
      });
      if (latestQuestionJobByUser.get(userKey) !== safeRequestId) return;

      const lambdaResult = buildLambdaResponse(rawResult, {
        defaultStatus: rawResult?.status === "pending" ? "pending" : "partial",
      });
      job.status = lambdaResult.answer_ready ? "ready" : lambdaResult.status;
      job.result = lambdaResult;
      job.visualPayload = rawResult?.payload || lambdaResult.payload || null;
      job.error = rawResult?.ok === false && !lambdaResult.answer_ready ? rawResult?.reason || null : null;
      setResumableJob(userKey, {
        requestId: safeRequestId,
        status: job.status,
        delivered: false,
      });
    })
    .catch((error) => {
      if (latestQuestionJobByUser.get(userKey) !== safeRequestId) return;
      job.status = "error";
      job.error = error?.message || "question_failed";
      job.result = buildPendingLambdaResponse({
        requestId: safeRequestId,
        voiceAnswer: "I couldn't retrieve your health data. Please try asking again.",
        status: "partial",
        sessionHints: deriveSessionHints(userKey, sessionHints),
      });
      setResumableJob(userKey, {
        requestId: safeRequestId,
        status: "error",
        delivered: false,
      });
    });

  return job;
}

function handleCompatResume(username, userInput, res) {
  const userKey = keyForUser(username);
  const action = normalizeControlAction(userInput?.action || "");
  if (!["resume_pending", "poll_pending"].includes(action)) return false;

  const explicitRequestId = sanitizeText(userInput?.requestId || "", 120, "") || null;
  const resumable = getResumableJob(userKey);
  const sessionHints = deriveSessionHints(userKey, userInput?.sessionHints || null);

  if (!resumable) {
    // No job tracked — fall through to handleControlWithOrchestrator so that
    // resume_pending checks the in-memory runtime stage state properly.
    return false;
  }

  if (explicitRequestId && resumable.requestId && explicitRequestId !== resumable.requestId) {
    res.json(buildPendingLambdaResponse({
      requestId: explicitRequestId,
      voiceAnswer: "There's no pending answer right now.",
      status: "partial",
      sessionHints,
    }));
    return true;
  }

  const job = qnaJobs.get(resumable.requestId);
  if (!job) {
    setResumableJob(userKey, null);
    res.json(buildPendingLambdaResponse({
      requestId: resumable.requestId,
      voiceAnswer: "There's no pending answer right now.",
      status: "partial",
      sessionHints,
    }));
    return true;
  }

  if (job.status === "ready" && job.result) {
    setResumableJob(userKey, null);
    res.json(buildLambdaResponse(job.result, { defaultStatus: "complete" }));
    return true;
  }

  if (job.status === "error" && job.result) {
    setResumableJob(userKey, null);
    res.json(buildLambdaResponse(job.result, { defaultStatus: "partial" }));
    return true;
  }

  res.json(buildPendingLambdaResponse({
    requestId: job.requestId,
    voiceAnswer: "",
    status: "partial",
    sessionHints: {
      activeStageIndex: Number(job.result?.activeStageIndex || sessionHints.activeStageIndex || 0),
      stageCount: Number(job.result?.stageCount || sessionHints.stageCount || 1),
    },
  }));
  return true;
}

async function loadActiveBundleForRouter(username) {
  const activeBundleId = sessionService.getActiveBundleId(username);
  if (activeBundleId) {
    const bundle = await getBundleById(activeBundleId);
    if (bundle) return bundle;
  }
  return loadActiveBundleForUser(username);
}

// ─────────────────────────────────────────────────────────────────────────────
// Lambda compat handler
//
// The Alexa Lambda sends a raw JSON-encoded string as the body (not an object)
// and appends followUp + tryAgain as query params:
//   POST /api/alexa?followUp=false&tryAgain=false   body: "\"show my steps\""
//   POST /api/alexa?followUp=true&tryAgain=true      body: "\"trying again\""
//
// This handler translates that into the router's internal job system and always
// responds with { GPTresponse, smallTalk } — the format the Lambda polls for.
// ─────────────────────────────────────────────────────────────────────────────
async function handleLambdaCompatRequest(req, res) {
  const rawText = sanitizeText(String(req.body || ""), 320, "");
  const isPolling = req.query?.tryAgain === "true";
  const username = "amy";

  function lambdaReply(gptResponse, smallTalk = "") {
    return res.json({ GPTresponse: gptResponse, smallTalk });
  }

  // ── POLL: Lambda is checking whether the background job has finished ────────
  if (isPolling) {
    routerLog("lambda-compat", "poll request", { username, rawText });

    const resumable = getResumableJob(username);
    if (!resumable) {
      return lambdaReply("Still working on that");
    }

    // Keep polling for up to 5 seconds — utilizes the full time Alexa allows
    // for the TryAgain/Resume turn so we avoid an extra round-trip when possible.
    const REQUEST_START_MS = Date.now();
    const POLL_BUDGET_MS = 5000;
    const deadline = REQUEST_START_MS + POLL_BUDGET_MS;

    while (Date.now() < deadline) {
      const job = qnaJobs.get(resumable.requestId);

      if (!job) {
        setResumableJob(username, null);
        return lambdaReply("Still working on that");
      }

      if (job.status === "ready" && job.result) {
        setResumableJob(username, null);
        if (job.result?.payload) {
          emitResultToFrontend(username, job.result, "question");
          emitStatus(username, "completed", "Your health analysis is ready.", {
            stageCount: Number(job.result.stageCount || job.result.payload?.stageCount || 1),
          });
        }
        const voice = sanitizeText(
          job.result.voice_answer || "Your health analysis is ready. Take a look at the chart on the screen.",
          320,
          "Here are your results."
        );
        return lambdaReply(voice);
      }

      if (job.status === "error") {
        setResumableJob(username, null);
        return lambdaReply("I couldn't retrieve your health data. Please try asking again.");
      }

      await new Promise((r) => setTimeout(r, 200));
    }

    return lambdaReply("Still working on that");
  }

  // ── QUESTION: new question from Lambda ──────────────────────────────────────
  // Lambda prepends "start " (with space) on the very first question of a session — strip it.
  const questionText = rawText.startsWith("start ")
    ? sanitizeText(rawText.slice(6), 320, "")
    : rawText;

  if (!questionText || questionText.length < 2) {
    return lambdaReply("I didn't catch that. Try asking about your health or fitness data.");
  }

  if (typeof getQuestionHandler() !== "function") {
    return lambdaReply("The health analysis service is temporarily unavailable. Please try again shortly.");
  }

  routerLog("lambda-compat", "new question", { username, question: questionText });

  // Navigate screen to /qna with a loading state right away
  emitStageNavigation(username, { loading: true, question: questionText });
  emitStatus(username, "loading", "Gathering your health data...");

  // Kick off the question job in the background and poll for the full 6-second
  // budget — this way Alexa gets the answer in one round-trip whenever possible.
  const REQUEST_START_MS = Date.now();
  const TOTAL_BUDGET_MS = 6000;

  const job = startQuestionJob({
    username,
    question: questionText,
    voiceDeadlineMs: VOICE_DEADLINE_MS,
    sessionHints: null,
    requestSource: "alexa",
  });

  const deadline = REQUEST_START_MS + TOTAL_BUDGET_MS;
  while (Date.now() < deadline) {
    if (job.status === "ready" && job.result) {
      setResumableJob(username, null);
      if (job.result?.payload) {
        emitResultToFrontend(username, job.result, "question");
        emitStatus(username, "completed", "Your health analysis is ready.", {
          stageCount: Number(job.result.stageCount || job.result.payload?.stageCount || 1),
        });
      }
      const voice = sanitizeText(
        job.result.voice_answer || "Your health analysis is ready. Take a look at the chart on your screen.",
        320,
        "Here are your results."
      );
      return lambdaReply(voice);
    }

    if (job.status === "error") {
      return lambdaReply("I had some trouble retrieving your health data. Please try again.");
    }

    await new Promise((r) => setTimeout(r, 200));
  }

  // Budget elapsed — job continues running in background.
  // Lambda will poll again with tryAgain=true on the next Alexa turn.
  routerLog("lambda-compat", "6s budget elapsed — returning still-working", {
    username,
    requestId: job.requestId,
  });
  return lambdaReply("Still working on that");
}

async function handleQuestion(username, userInput, res, sessionHintsOverride = null) {
  // Track wall-clock time from the very start so the job polling deadline
  // automatically shrinks to fit however long classifyIntent takes.
  const REQUEST_START_MS = Date.now();
  const TOTAL_BUDGET_MS = 6000;

  const rawText = sanitizeText(userInput?.text || userInput?.question || "", 320, "");
  const enrichedIntent = await classifyIntent(rawText, {}).catch(() => null);
  const question = sanitizeText(enrichedIntent?.normalized_question || rawText, 320, "");

  if (!question) {
    return res.status(400).json({
      ok: false,
      answer_ready: false,
      voice_answer: "I didn't catch that. Try asking about your health or fitness data.",
    });
  }

  // ── Small-talk guard ────────────────────────────────────────────────────────
  if (enrichedIntent?.intent_type === "general_conversation") {
    routerLog("handleQuestion", "small talk detected — routing to resume_pending", {
      username,
      text: rawText,
      confidence: enrichedIntent?.confidence,
    });
    const controlHandler = getControlHandler();
    if (typeof controlHandler === "function") {
      const resumeResult = await controlHandler({
        username,
        action: "resume_pending",
        requestId: sanitizeText(userInput?.requestId || "", 120, "") || null,
        sessionHints: sessionHintsOverride || userInput?.sessionHints || null,
      }).catch(() => null);
      if (hasReadyPayload(resumeResult)) {
        emitResultToFrontend(username, resumeResult, "resume");
        return res.json(buildLambdaResponse(resumeResult, { defaultStatus: "complete" }));
      }
      return res.json(buildPendingLambdaResponse({
        result: resumeResult,
        voiceAnswer: resumeResult?.voice_answer
          || "Your analysis is still being prepared. Say next when you'd like to continue.",
        status: "partial",
        sessionHints: deriveSessionHints(username, sessionHintsOverride || userInput?.sessionHints || null),
      }));
    }
    return res.json(buildPendingLambdaResponse({
      voiceAnswer: "I'm working on your data. Go ahead and ask me a health question whenever you're ready.",
      status: "partial",
      sessionHints: deriveSessionHints(username, sessionHintsOverride || userInput?.sessionHints || null),
    }));
  }
  // ── End small-talk guard ────────────────────────────────────────────────────

  if (typeof getQuestionHandler() !== "function") {
    return res.status(500).json({
      ok: false,
      answer_ready: false,
      voice_answer: "The health analysis service is temporarily unavailable. Please try again shortly.",
    });
  }

  emitStageNavigation(username, { loading: true, question: rawText });
  emitStatus(username, "loading", "Gathering your health data...");

  const sessionHints = sessionHintsOverride || userInput?.sessionHints || null;

  const job = startQuestionJob({
    username,
    question,
    requestId: sanitizeText(userInput?.requestId || "", 120, "") || null,
    voiceDeadlineMs: Number(userInput?.voiceDeadlineMs || 0) || VOICE_DEADLINE_MS,
    sessionHints,
    requestSource: "alexa",
  });

  const deadline = REQUEST_START_MS + TOTAL_BUDGET_MS;
  while (Date.now() < deadline) {
    if (job.status === "ready" && job.result) {
      setResumableJob(username, null);
      if (job.result?.payload) {
        emitResultToFrontend(username, job.result, "question");
        emitStatus(username, "completed", "Your health analysis is ready.", {
          stageCount: Number(job.result.stageCount || job.result.payload?.stageCount || 1),
        });
      }
      return res.json(buildLambdaResponse(job.result, { defaultStatus: "complete" }));
    }
    if (job.status === "error") {
      return res.json(buildPendingLambdaResponse({
        result: job.result,
        voiceAnswer: "I couldn't retrieve your health data. Please try asking again.",
        status: "partial",
        sessionHints: deriveSessionHints(username, sessionHints),
      }));
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  routerLog("handleQuestion", "voice deadline reached — returning pending", { username, requestId: job.requestId });
  return res.json(buildPendingLambdaResponse({
    requestId: job.requestId,
    voiceAnswer: "I'm still pulling your data together. Give me just a moment more.",
    status: "pending",
    sessionHints: deriveSessionHints(username, sessionHints),
  }));
}

async function handleControl(username, userInput, res, sessionHintsOverride = null) {
  if (handleCompatResume(username, userInput, res)) return;

  const action = normalizeControlAction(userInput?.action || "");
  const sessionHints = sessionHintsOverride || userInput?.sessionHints || null;
  const controlHandler = getControlHandler();

  if (!action) {
    return res.json(buildPendingLambdaResponse({
      voiceAnswer: "I couldn't load that section. Please try again.",
      status: "partial",
      sessionHints: deriveSessionHints(username, sessionHints),
    }));
  }

  if (typeof controlHandler !== "function") {
    return res.json(buildPendingLambdaResponse({
      voiceAnswer: "I couldn't load that section. Please try again.",
      status: "partial",
      sessionHints: deriveSessionHints(username, sessionHints),
    }));
  }

  if (!sessionService.getActiveBundleId(username)
    && !userInput?.requestId
    && !sessionHints?.activeStageIndex
    && !sessionHints?.stageCount
    && ["show_more", "back", "compare", "go_deeper", "explain", "summarize", "start_over"].includes(action)) {
    return res.json(buildPendingLambdaResponse({
      voiceAnswer: "I don't have an active health analysis yet. Try asking a health question first.",
      status: "partial",
      sessionHints: deriveSessionHints(username, sessionHints),
    }));
  }

  const result = await controlHandler({
    username,
    action,
    requestId: sanitizeText(userInput?.requestId || "", 120, "") || null,
    sessionHints,
  });

  if (hasReadyPayload(result) && result?.payload) {
    emitResultToFrontend(username, result, action === "resume_pending" ? "resume" : "control");
    emitStatus(username, "completed", "Chart ready.", {
      stageCount: Number(result.stageCount || result.payload?.stageCount || 1),
      activeStageIndex: Number(result.activeStageIndex || result.payload?.activeStageIndex || 0),
    });
    return res.json(buildLambdaResponse(result, { defaultStatus: "complete" }));
  }

  const fallbackVoice = result?.voice_answer
    || result?.voiceAnswer
    || (["show_more", "back", "compare", "go_deeper"].includes(action)
      ? "I'm still preparing the next chart. Just a moment."
      : "I couldn't move to that section yet.");
  emitStatus(username, "loading", "Preparing the next chart...");
  return res.json(buildPendingLambdaResponse({
    result,
    voiceAnswer: fallbackVoice,
    status: "partial",
    sessionHints: deriveSessionHints(username, sessionHints),
  }));
}

alexaRouter.post("/", async (req, res) => {
  // ── Lambda compat: detect raw-string body sent by the Alexa Lambda ──────────
  // The Lambda posts a JSON-encoded string (e.g. "\"show my steps\"") rather
  // than a structured object, so req.body will be a JS string after JSON parsing.
  if (typeof req.body === "string") {
    try {
      return await handleLambdaCompatRequest(req, res);
    } catch (error) {
      routerError("lambda-compat", "request failed", error);
      emitStatus("amy", "error", "Something went wrong. Please try again.");
      return res.status(500).json({ GPTresponse: "I had some trouble with that. Please try again.", smallTalk: "" });
    }
  }
  // ── Structured object path (browser / non-Lambda callers) ───────────────────

  const username = keyForUser(req.body?.username || req.body?.userInput?.username || "");
  const userInput = req.body?.userInput || {};
  const type = String(userInput?.type || "question").trim().toLowerCase();

  routerLog("alexa", "incoming request", {
    username,
    type,
    action: userInput?.action || null,
  });

  try {
    if (type === "control") {
      return await handleControl(username, userInput, res);
    }

    if (type === "utterance") {
      const utterance = sanitizeText(userInput?.text || "", 320, "");
      const enrichedIntent = await classifyIntent(utterance, {}).catch(() => null);
      if (enrichedIntent?.is_navigation) {
        const mappedAction = normalizeControlAction(enrichedIntent?.control_action || "show_more");
        return await handleControl(username, { ...userInput, action: mappedAction, type: "control" }, res);
      }
      return await handleQuestion(username, { ...userInput, text: utterance }, res);
    }

    return await handleQuestion(username, userInput, res);
  } catch (error) {
    routerError("alexa", "request failed", error);
    emitStatus(username, "error", "Something went wrong. Please try again.");
    return res.status(500).json({
      ok: false,
      answer_ready: false,
      voice_answer: "I had trouble with your health data. Please try again.",
    });
  }
});

alexaRouter.post("/browser-query", async (req, res) => {
  const username = keyForUser(req.body?.username || "amy");
  const question = sanitizeText(req.body?.question, 320, "");

  if (!question) {
    return res.status(400).json({ ok: false, error: "question is required" });
  }

  res.status(200).json({ ok: true });
  emitStatus(username, "loading", "Building your charts...");

  try {
    const questionHandler = getQuestionHandler();
    if (typeof questionHandler !== "function") throw new Error("question handler unavailable");
    const result = await questionHandler({
      username,
      question,
      requestId: `bq_${Date.now()}`,
      requestSource: "browser",
      voiceDeadlineMs: 12000,
    });

    if ((result?.answer_ready === true || result?.answerReady === true) && result?.payload) {
      emitResultToFrontend(username, result, "question");
      emitStatus(username, "completed", "Your health analysis is ready.", {
        stageCount: Number(result.stageCount || result.payload?.stageCount || 1),
      });
      return;
    }

    emitStatus(username, "loading", "The first chart is still preparing...");
  } catch (error) {
    routerError("browser-query", "browser query failed", error);
    emitStatus(username, "error", "I couldn't build that chart. Try rephrasing your question.");
  }
});

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

alexaRouter.get("/back", (req, res) => {
  const username = keyForUser(req.query?.username || "amy");
  const clearRuntimeState = getRuntimeClearHandler();
  if (clearRuntimeState) clearRuntimeState(username);
  clearCompatState(username);
  emitToScreen(username, { action: "qnaEnd", reason: "user_done" });
  routerLog("session", "session cleared", { username });
  return res.status(200).json({ ok: true });
});

alexaRouter._test = {
  qnaJobs,
  resetState() {
    const clearRuntimeState = getRuntimeClearHandler();
    if (clearRuntimeState) clearRuntimeState();
    clearCompatState();
    sessionService.clearSessionState("amy");
  },
  setResumableJob,
  getResumableJob,
  startQuestionJob,
  async handleQuestion(username, userInput, res, sessionHints) {
    return handleQuestion(username, userInput, res, sessionHints);
  },
  async handleControl(username, userInput, res, sessionHints) {
    return handleControl(username, userInput, res, sessionHints);
  },
  async getCurrentStagePayload(username) {
    const bundle = await loadActiveBundleForRouter(username);
    if (!bundle) return null;
    const stage = getStageByIndex(bundle, bundle.currentStageIndex) || replayStoredStage({
      bundle,
      stageIndex: bundle.currentStageIndex,
      question: bundle.question || "",
    })?.stage;
    return stage || null;
  },
};

module.exports = alexaRouter;
