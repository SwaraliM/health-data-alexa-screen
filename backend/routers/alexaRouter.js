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
  answerFollowupFromPayload,
} = require("../services/qnaEngine");
const { generateSpeech } = require("../services/ttsService");
const {
  handleControlWithOrchestrator,
  handleFollowupWithOrchestrator,
  handleQuestionWithOrchestrator,
  runPlannerShadow,
} = require("../services/qna/qnaOrchestrator");
const { recordSessionAudit } = require("../services/qna/auditService");
const { clearSessionState } = require("../services/qna/sessionService");

const qnaSession = new Map();
const qnaJobs = new Map();
const resumableJobs = new Map();
const SLOW_RESPONSE_STATUS_MS = 7000;
const INLINE_QUESTION_WAIT_MS = Math.max(
  0,
  Number(process.env.QNA_INLINE_QUESTION_WAIT_MS || 1800)
);

const ROUTER_DEBUG = process.env.QNA_ROUTER_DEBUG !== "false";

function routerLog(scope, message, data = null) {
  if (!ROUTER_DEBUG) return;
  if (data == null) return console.log(`[AlexaRouter][${scope}] ${message}`);
  // console.log(`[AlexaRouter][${scope}] ${message}`, data);
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
    // routerLog("websocket", "sending websocket message", {
    //   username: userKey,
    //   action: message?.action,
    //   option: message?.option || null,
    //   registeredClients: Array.from(clients.keys()),
    // });
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

function getResumableJob(username) {
  return resumableJobs.get(keyForUser(username)) || null;
}

function setResumableJob(username, patch) {
  const userKey = keyForUser(username);
  const next = {
    requestId: null,
    status: "pending",
    delivered: false,
    updatedAt: Date.now(),
    ...(getResumableJob(userKey) || {}),
    ...(patch || {}),
  };
  resumableJobs.set(userKey, next);
  return next;
}

function syncResumableJob(username, requestId, patch) {
  const userKey = keyForUser(username);
  const current = getResumableJob(userKey);
  if (!current || current.requestId !== String(requestId || "").trim()) return null;
  return setResumableJob(userKey, patch);
}

function clearResumableJob(username, requestId = null) {
  const userKey = keyForUser(username);
  const current = getResumableJob(userKey);
  if (!current) return false;
  if (requestId && current.requestId !== String(requestId || "").trim()) return false;
  resumableJobs.delete(userKey);
  return true;
}

function isCurrentResumableRequest(username, requestId) {
  const active = getResumableJob(username);
  if (!active?.requestId || !requestId) return false;
  return active.requestId === String(requestId || "").trim();
}

function buildNoPendingResumeResponse(message = "There is no pending answer right now. Ask me a health question first.") {
  return {
    status: "error",
    payload_ready: false,
    answer_ready: false,
    voice_answer_source: "fallback",
    voice_answer: message,
  };
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

function parseRequestedStageIndex(userInput = {}) {
  const candidate = userInput?.stageIndex ?? userInput?.stage ?? userInput?.index ?? null;
  if (candidate == null || candidate === "") return null;
  const parsed = Number(candidate);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : null;
}

function normalizeIncomingControlAction(action = "") {
  const value = String(action || "").trim().toLowerCase();
  if (!value) return "";
  if (["stage_next", "next", "show_more", "show more", "more", "tell me more", "yes", "yeah", "sure", "ok", "okay"].includes(value)) return "show_more";
  if (["stage_back", "back", "go back", "previous", "prev"].includes(value)) return "back";
  if (["stage_replay", "replay", "repeat", "show again"].includes(value)) return "replay";
  if (["stage_goto", "go_to_stage", "goto_stage", "goto"].includes(value)) return "goto_stage";
  if (["compare", "compare that", "compare this"].includes(value)) return "compare";
  if ([
    "explain",
    "explain that",
    "what does this mean",
    "why is that",
    "what stands out",
    "what am i looking at",
  ].includes(value)) return "explain";
  if (["summarize", "summarize this", "recap"].includes(value)) return "summarize";
  if (["start_over", "start over", "restart", "reset"].includes(value)) return "start_over";
  return value.replace(/\s+/g, "_");
}

function asNonNegativeInt(value, fallback = null) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
}

function extractSessionHints(reqBody = {}, userInput = {}) {
  const merged = {
    ...(reqBody?.sessionHints && typeof reqBody.sessionHints === "object" ? reqBody.sessionHints : {}),
    ...(userInput?.sessionHints && typeof userInput.sessionHints === "object" ? userInput.sessionHints : {}),
  };
  const directHints = {
    activeStageIndex: userInput?.activeStageIndex,
    stageCount: userInput?.stageCount,
    pendingAction: userInput?.pendingAction,
    lastQuestion: userInput?.lastQuestion,
  };
  Object.entries(directHints).forEach(([key, value]) => {
    if (value != null && value !== "" && merged[key] == null) merged[key] = value;
  });

  const normalized = {
    activeStageIndex: asNonNegativeInt(merged.activeStageIndex, null),
    stageCount: asNonNegativeInt(merged.stageCount, null),
    pendingAction: String(merged.pendingAction || "").trim() || null,
    lastQuestion: String(merged.lastQuestion || "").trim() || null,
  };
  const hasHints = normalized.activeStageIndex != null
    || normalized.stageCount != null
    || Boolean(normalized.pendingAction)
    || Boolean(normalized.lastQuestion);
  return hasHints ? normalized : null;
}

function toLambdaStatus(status = "", answerReady = false) {
  const value = String(status || "").trim().toLowerCase();
  if (value === "error") return "partial";
  if (["ready", "complete", "completed"].includes(value)) return "complete";
  if (answerReady) return "complete";
  return "partial";
}

function syncBundleStateToLambdaShape({
  payload = null,
  stageCount = null,
  activeStageIndex = null,
  sessionHints = null,
} = {}) {
  const fromPayloadCount = asNonNegativeInt(payload?.stageCount, null);
  const fromPayloadStagesCount = Array.isArray(payload?.stages) ? payload.stages.length : null;
  const fromPayloadActiveIndex = asNonNegativeInt(
    payload?.activeStageIndex ?? payload?.currentStageIndex,
    null
  );

  let normalizedStageCount = fromPayloadCount != null ? fromPayloadCount : fromPayloadStagesCount;
  if (normalizedStageCount == null) normalizedStageCount = asNonNegativeInt(stageCount, null);
  if (normalizedStageCount == null) normalizedStageCount = asNonNegativeInt(sessionHints?.stageCount, null);

  let normalizedActiveIndex = fromPayloadActiveIndex;
  if (normalizedActiveIndex == null) normalizedActiveIndex = asNonNegativeInt(activeStageIndex, null);
  if (normalizedActiveIndex == null) normalizedActiveIndex = asNonNegativeInt(sessionHints?.activeStageIndex, null);

  if (normalizedActiveIndex == null) {
    normalizedActiveIndex = normalizedStageCount != null && normalizedStageCount > 0
      ? Math.max(0, normalizedStageCount - 1)
      : 0;
  }

  if (normalizedStageCount == null) {
    normalizedStageCount = Math.max(1, normalizedActiveIndex + 1);
  } else if (normalizedStageCount <= normalizedActiveIndex) {
    normalizedStageCount = normalizedActiveIndex + 1;
  }

  return {
    stageCount: normalizedStageCount,
    activeStageIndex: normalizedActiveIndex,
  };
}

function buildLambdaCompatibleResponse(base = {}, {
  payload = null,
  voiceAnswer = null,
  status = null,
  stageCount = null,
  activeStageIndex = null,
  sessionHints = null,
} = {}) {
  const resolvedPayload = payload || base?.payload || null;
  const stageShape = syncBundleStateToLambdaShape({
    payload: resolvedPayload,
    stageCount,
    activeStageIndex,
    sessionHints,
  });
  const resolvedVoiceAnswer = String(
    voiceAnswer
      ?? base?.voice_answer
      ?? resolvedPayload?.voice_answer
      ?? resolvedPayload?.spoken_answer
      ?? ""
  ).trim();
  const answerReady = Boolean(base?.answer_ready || resolvedPayload?.answer_ready || resolvedVoiceAnswer);

  return {
    ...base,
    status: status || toLambdaStatus(base?.status, answerReady),
    voice_answer: resolvedVoiceAnswer,
    stageCount: stageShape.stageCount,
    activeStageIndex: stageShape.activeStageIndex,
  };
}

function clearJobTimers(job) {
  if (!job) return;
  if (job.slowStatusTimer) {
    clearTimeout(job.slowStatusTimer);
    job.slowStatusTimer = null;
  }
}

async function waitForJobSettlement(requestId, timeoutMs = INLINE_QUESTION_WAIT_MS) {
  const waitMs = Math.max(0, Number(timeoutMs) || 0);
  if (waitMs <= 0) {
    return getJob(requestId);
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < waitMs) {
    const job = getJob(requestId);
    if (!job) return null;
    if (["ready", "error"].includes(String(job.status || "").toLowerCase())) {
      return job;
    }
    // Small polling delay keeps router responsive while allowing fast stage-1 completion.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return getJob(requestId);
}

function buildFollowupApiResponse(orchestrated = {}) {
  const payload = orchestrated?.payload || null;
  const suggestedQuestions = payload?.suggestedDrillDowns
    || payload?.suggested_follow_up
    || payload?.next_views?.map((view) => view?.label).filter(Boolean)
    || [];

  return {
    answer: payload?.voice_answer || orchestrated?.voiceAnswer || "",
    answer_ready: Boolean(payload?.answer_ready),
    voice_answer_source: payload?.voice_answer_source || orchestrated?.voiceAnswerSource || "gpt",
    suggestedQuestions,
    payload,
    orchestrator: orchestrated?.orchestrator || null,
  };
}

/**
 * Planner shadow sidecar for follow-up traffic.
 * Main question flow now uses the primary orchestrator entrypoint.
 *
 * planner runs in shadow mode and stores bundle-planning state,
 * but does not change live spoken answers/chart payloads.
 */
function triggerPlannerShadowSidecar({ username, question }) {
  Promise.resolve()
    .then(() => runPlannerShadow({ username, question }))
    .then((result) => {
      if (!result || result.skipped) {
        routerLog("planner-shadow", "shadow planner skipped", {
          username,
          reason: result?.reason || "unknown",
        });
        return;
      }
      routerLog("planner-shadow", "shadow planner completed", {
        username,
        action: result.action,
        bundleId: result.bundleId,
        mode: result?.plannerResult?.mode || null,
      });
    })
    .catch((error) => {
      routerWarn("planner-shadow", "shadow planner failed", {
        username,
        message: error?.message || String(error),
      });
    });
}

/**
 * Launches the backend QnA job immediately so Alexa can poll it.
 */
function startQuestionJob({
  username,
  question,
  voiceDeadlineMs = 4200,
  sessionHints = null,
} = {}) {
  const requestId = makeRequestId(username, question);
  const userKey = keyForUser(username);
  const bridgeVoice = "I am analyzing your health data now.";
  const previousResumable = getResumableJob(userKey);

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
    slowStatusTimer: null,
  };

  qnaJobs.set(requestId, job);
  setResumableJob(userKey, {
    requestId,
    status: "pending",
    delivered: false,
  });
  if (previousResumable?.requestId && previousResumable.requestId !== requestId) {
    routerWarn("jobs", "concurrent request detected, superseding prior resumable job", {
      username: userKey,
      previousRequestId: previousResumable.requestId,
      requestId,
    });
    recordSessionAudit({
      eventType: "concurrent_request_detected",
      username: userKey,
      requestKey: requestId,
      source: "alexa",
      reason: "router_superseded_previous_request",
      extra: {
        previousRequestId: previousResumable.requestId,
      },
    });
  }
  routerLog("jobs", "starting QnA job", { requestId, username: userKey, question });

  emitStatus(userKey, "loading", "Analyzing your health data...");
  emitQnaPayload(userKey, { loading: true, question }, "navigation");

  job.slowStatusTimer = setTimeout(() => {
    const activeJob = qnaJobs.get(requestId);
    if (!activeJob || activeJob.status !== "pending") return;
    emitStatus(userKey, "slow", "This is taking a little longer. I will read the answer as soon as it is ready.", {
      requestId,
    });
  }, SLOW_RESPONSE_STATUS_MS);

  handleQuestionWithOrchestrator({
    requestId,
    username: userKey,
    question,
    voiceDeadlineMs,
    sessionHints,
    allowFetchPlannerLLM: true,
    allowPresenterLLM: true,
    enableVisualContinuation: true,
  })
    .then((result) => {
      if (!isCurrentResumableRequest(userKey, requestId)) {
        routerWarn("jobs", "stale async result discarded", {
          username: userKey,
          requestId,
          reason: "superseded_by_newer_request",
          stageGenerator: result?.orchestrator?.stageGenerator || null,
        });
        recordSessionAudit({
          eventType: "stale_result_discarded",
          username: userKey,
          requestKey: requestId,
          source: "alexa",
          reason: "router_primary_result_stale",
          result: result?.orchestrator?.stageGenerator || "unknown",
        });
        return;
      }

      if (result?.stale) {
        routerWarn("jobs", "orchestrator returned stale result marker", {
          username: userKey,
          requestId,
          reason: result?.reason || "stale_result",
        });
        recordSessionAudit({
          eventType: "stale_result_discarded",
          username: userKey,
          requestKey: requestId,
          source: "alexa",
          reason: result?.reason || "stale_result",
        });
        return;
      }

      const pathStageGen = result?.orchestrator?.stageGenerator || null;
      const pathBundleId = result?.bundleId || result?.orchestrator?.bundleId || null;
      routerLog("jobs", "path=" + (pathStageGen === "legacy_fallback" ? "legacy_fallback" : pathStageGen || "unknown") + " bundleId=" + (pathBundleId || "null"), {
        requestId,
        stageGenerator: pathStageGen,
        fallbackReason: result?.orchestrator?.fallbackReason || null,
        bundleId: pathBundleId,
      });

      job.visualPayload = result.payload || null;
      if (result.payload) {
        storeSession(userKey, result.payload);
        emitQnaPayload(userKey, result.payload, "navigation");
      }

      if (result.answerReady && result.payload?.answer_ready) {
        clearJobTimers(job);
        job.status = "ready";
        job.result = result.payload;
        syncResumableJob(userKey, requestId, {
          status: "ready",
          delivered: false,
        });
        emitStatus(userKey, "completed", "Your answer is ready.", {
          requestId,
          suggestion: result.payload?.next_views?.[0]?.label || result.payload?.suggestedDrillDowns?.[0] || null,
        });
      } else {
        job.status = "pending";
        syncResumableJob(userKey, requestId, {
          status: "pending",
          delivered: false,
        });
      }

      const speechReadyPromise = result.speechReadyPromise;
      if (speechReadyPromise && typeof speechReadyPromise.then === "function") {
        speechReadyPromise
          .then((gptPayload) => {
            if (!isCurrentResumableRequest(userKey, requestId)) {
              routerWarn("jobs", "stale speech continuation discarded", {
                username: userKey,
                requestId,
              });
              recordSessionAudit({
                eventType: "stale_result_discarded",
                username: userKey,
                requestKey: requestId,
                source: "alexa",
                reason: "router_speech_continuation_stale",
              });
              return;
            }
            if (!qnaJobs.has(requestId) || !gptPayload?.answer_ready) return;
            clearJobTimers(job);
            job.status = "ready";
            job.result = gptPayload;
            job.visualPayload = gptPayload;
            syncResumableJob(userKey, requestId, {
              status: "ready",
              delivered: false,
            });
            storeSession(userKey, gptPayload);
            emitQnaPayload(userKey, gptPayload, "updateVisuals");
            emitStatus(userKey, "completed", "Your answer is ready.", {
              requestId,
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
            if (!isCurrentResumableRequest(userKey, requestId)) {
              routerWarn("jobs", "stale visual continuation discarded", {
                username: userKey,
                requestId,
              });
              recordSessionAudit({
                eventType: "stale_result_discarded",
                username: userKey,
                requestKey: requestId,
                source: "alexa",
                reason: "router_visual_continuation_stale",
              });
              return;
            }
            if (!qnaJobs.has(requestId)) return;
            job.visualPayload = richPayload;
            if (richPayload?.answer_ready) job.result = richPayload;
            syncResumableJob(userKey, requestId, {
              status: richPayload?.answer_ready ? "ready" : job.status,
              delivered: false,
            });
            storeSession(userKey, richPayload);
            emitQnaPayload(userKey, richPayload, "updateVisuals");
          })
          .catch((error) => {
            routerError("jobs", "rich continuation failed", error);
          });
      }
    })
    .catch((error) => {
      clearJobTimers(job);
      job.status = "error";
      job.error = error?.message || "Unknown error";
      clearResumableJob(userKey, requestId);
      emitStatus(userKey, "error", "I could not complete that request.", { requestId });
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
    const orchestrated = await handleQuestionWithOrchestrator({
      requestId,
      username,
      question,
      voiceDeadlineMs: 4200,
      allowFetchPlannerLLM: true,
      allowPresenterLLM: true,
      enableVisualContinuation: false,
    });
    if (!orchestrated?.payload) {
      throw new Error("No payload from orchestrator");
    }
    storeSession(username, orchestrated.payload);
    emitQnaPayload(username, orchestrated.payload, "navigation");
    emitStatus(username, "completed", "Your answer is ready.", {
      suggestion: orchestrated.payload?.next_views?.[0]?.label || orchestrated.payload?.suggestedDrillDowns?.[0] || null,
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

  try {
    const requestId = makeRequestId(username, question);
    const orchestrated = await handleFollowupWithOrchestrator({
      requestId,
      username,
      question,
      bundleId: req.body?.bundleId || payload?.bundleId || null,
      voiceDeadlineMs: Number(req.body?.voiceDeadlineMs) || 4200,
    });

    if (orchestrated?.payload) {
      storeSession(username, orchestrated.payload);
      emitQnaPayload(username, orchestrated.payload, "updateVisuals");
      return res.status(200).json(buildFollowupApiResponse(orchestrated));
    }

    if (!payload) {
      return res.status(200).json({
        answer: "I do not have enough context yet. Ask a health question first.",
        suggestedQuestions: ["How did I sleep this week?"],
      });
    }

    // Orchestrator returned no payload but a prior session exists.
    // Return a voice-safe response that keeps the user in the sequential model
    // rather than falling back to the legacy all-at-once chart engine.
    routerWarn("followup", "path=followup_no_payload reason=orchestrator_no_payload", {
      username,
      question,
      bundleId: req.body?.bundleId || payload?.bundleId || null,
    });
    return res.status(200).json({
      answer: "I had trouble with that. You can say 'show more' to continue, or ask a new health question.",
      answer_ready: true,
      voice_answer_source: "fallback",
      suggestedQuestions: payload?.suggestedDrillDowns || payload?.suggested_follow_up || ["Show more"],
      payload,
    });
  } catch (error) {
    routerError("followup", "follow-up threw unexpectedly", error);
    return res.status(200).json({
      answer: "Sorry, I had trouble with that. Say 'show more' to continue, or ask a new health question.",
      answer_ready: true,
      voice_answer_source: "fallback",
      suggestedQuestions: payload?.suggestedDrillDowns || payload?.suggested_follow_up || ["Show more"],
      payload: payload || null,
    });
  }
});

/**
 * Alexa starts a job and polls this same router for readiness.
 */
async function handleQuestion(username, userInput, res, sessionHints = null) {
  const question = String(userInput?.text || userInput?.data || "").trim();
  if (!question) {
    return res.status(200).json(buildLambdaCompatibleResponse({
      status: "error",
      voice_answer: "What would you like to know about your health data?",
    }, { sessionHints }));
  }

  const voiceDeadlineMs = Number(userInput?.voiceDeadlineMs) || 4200;

  const job = startQuestionJob({
    username,
    question,
    voiceDeadlineMs,
    sessionHints,
  });
  const inlineWaitMs = Math.min(
    Math.max(0, Number(userInput?.inlineWaitMs ?? INLINE_QUESTION_WAIT_MS)),
    Math.max(0, voiceDeadlineMs)
  );
  const settledJob = await waitForJobSettlement(job.requestId, inlineWaitMs);
  const settledPayload = settledJob?.result || settledJob?.visualPayload || null;

  if (settledJob?.status === "ready" && settledPayload?.answer_ready) {
    return res.status(200).json(buildLambdaCompatibleResponse({
      status: "ready",
      requestId: job.requestId,
      payload_ready: true,
      answer_ready: true,
      voice_answer_source: settledPayload?.voice_answer_source || "gpt",
      voice_answer: settledPayload?.voice_answer || "",
      payload: settledPayload,
    }, {
      payload: settledPayload,
      sessionHints,
      status: "complete",
    }));
  }

  if (settledJob?.status === "error") {
    return res.status(200).json(buildLambdaCompatibleResponse({
      status: "error",
      requestId: job.requestId,
      payload_ready: Boolean(settledPayload),
      answer_ready: Boolean(settledPayload?.answer_ready),
      voice_answer_source: settledPayload?.voice_answer_source || "fallback",
      voice_answer: settledPayload?.voice_answer || "I could not complete that request right now.",
      payload: settledPayload,
    }, {
      payload: settledPayload,
      sessionHints,
      status: "partial",
    }));
  }

  return res.status(200).json(buildLambdaCompatibleResponse({
    status: "pending",
    requestId: job.requestId,
    payload_ready: Boolean(settledPayload),
    answer_ready: false,
    voice_answer_source: settledPayload?.voice_answer_source || "bridge",
    voice_answer: settledPayload?.voice_answer || "I am analyzing your health data now.",
    payload: settledPayload,
  }, {
    payload: settledPayload,
    sessionHints,
    status: "partial",
  }));
}

async function handleControl(username, userInput, res, sessionHints = null) {
  const rawAction = String(userInput?.action || "");
  const action = normalizeIncomingControlAction(rawAction);
  const hints = sessionHints || null;
  routerLog("control", "handling control action", {
    username,
    action,
    rawAction,
    requestId: userInput?.requestId,
  });

  if (action === "poll_pending") {
    const job = getJob(userInput?.requestId);
    if (!job) {
      return res.status(200).json(buildLambdaCompatibleResponse({
        status: "error",
        payload_ready: false,
        answer_ready: false,
        voice_answer_source: "fallback",
        voice_answer: "I could not find that pending answer. Please ask again.",
      }, { sessionHints: hints }));
    }
    const payload = job.result || job.visualPayload || null;
    if (job.status !== "ready" || !payload?.answer_ready) {
      return res.status(200).json(buildLambdaCompatibleResponse({
        status: job.status,
        requestId: job.requestId,
        payload_ready: Boolean(payload),
        answer_ready: false,
        voice_answer_source: payload?.voice_answer_source || "bridge",
        payload,
        voice_answer: "",
      }, {
        payload,
        sessionHints: hints,
      }));
    }
    clearResumableJob(username, job.requestId);
    return res.status(200).json(buildLambdaCompatibleResponse({
      status: "ready",
      requestId: job.requestId,
      payload_ready: true,
      answer_ready: true,
      voice_answer_source: payload.voice_answer_source || "gpt",
      voice_answer: payload.voice_answer || "",
      payload,
    }, {
      payload,
      sessionHints: hints,
      status: "complete",
    }));
  }

  if (action === "resume_pending") {
    const requestedId = String(userInput?.requestId || "").trim();
    const activeResume = getResumableJob(username);
    if (!activeResume) {
      return res.status(200).json(buildLambdaCompatibleResponse(
        buildNoPendingResumeResponse(),
        { sessionHints: hints }
      ));
    }

    if (requestedId && activeResume.requestId !== requestedId) {
      return res.status(200).json(buildLambdaCompatibleResponse(
        buildNoPendingResumeResponse(),
        { sessionHints: hints }
      ));
    }

    const job = getJob(activeResume.requestId);
    if (!job) {
      clearResumableJob(username, activeResume.requestId);
      return res.status(200).json(buildLambdaCompatibleResponse(
        buildNoPendingResumeResponse("I could not find that pending answer. Please ask again."),
        { sessionHints: hints }
      ));
    }

    const payload = job.result || job.visualPayload || null;
    if (job.status !== "ready" || !payload?.answer_ready) {
      syncResumableJob(username, activeResume.requestId, { status: job.status || "pending" });
      return res.status(200).json(buildLambdaCompatibleResponse({
        status: job.status,
        requestId: job.requestId,
        payload_ready: Boolean(payload),
        answer_ready: false,
        voice_answer_source: payload?.voice_answer_source || "bridge",
        payload,
        voice_answer: "",
      }, {
        payload,
        sessionHints: hints,
      }));
    }

    clearResumableJob(username, activeResume.requestId);
    return res.status(200).json(buildLambdaCompatibleResponse({
      status: "ready",
      requestId: job.requestId,
      payload_ready: true,
      answer_ready: true,
      voice_answer_source: payload.voice_answer_source || "gpt",
      voice_answer: payload.voice_answer || "",
      payload,
    }, {
      payload,
      sessionHints: hints,
      status: "complete",
    }));
  }

  if (action === "job_status") {
    return res.status(200).json(buildLambdaCompatibleResponse(serializeJob(getJob(userInput?.requestId)) || {
      status: "error",
      payload_ready: false,
      answer_ready: false,
      voice_answer_source: "fallback",
      voice_answer: "Request not found.",
    }, { sessionHints: hints }));
  }

  if ([
    "show_more",
    "back",
    "replay",
    "goto_stage",
    "compare",
    "explain",
    "summarize",
    "start_over",
  ].includes(action)) {
    const requestedStageIndex = parseRequestedStageIndex(userInput);
    const controlResult = await handleControlWithOrchestrator({
      username,
      action,
      stageIndex: requestedStageIndex,
      bundleId: userInput?.bundleId || null,
      requestId: userInput?.requestId || null,
      question: String(userInput?.question || userInput?.text || "").trim(),
      voiceDeadlineMs: Number(userInput?.voiceDeadlineMs) || 4200,
      sessionHints: hints,
    });

    const ctrlStageGen = controlResult?.orchestrator?.stageGenerator || null;
    const ctrlBundleId = controlResult?.bundleId || controlResult?.orchestrator?.bundleId || null;
    routerLog("control", "path=" + (ctrlStageGen === "legacy_navigation_fallback" ? "legacy_fallback" : ctrlStageGen || "unknown") + " bundleId=" + (ctrlBundleId || "null"), {
      username,
      action,
      requestedStageIndex,
      ok: Boolean(controlResult?.ok),
      reason: controlResult?.orchestrator?.fallbackReason || controlResult?.reason || null,
      stageGenerator: ctrlStageGen,
      bundleId: ctrlBundleId,
    });

    if (controlResult?.stale) {
      routerWarn("control", "stale navigation result discarded", {
        username,
        action,
        requestedStageIndex,
        reason: controlResult?.reason || "stale_result",
      });
      recordSessionAudit({
        eventType: "stale_result_discarded",
        username,
        requestKey: userInput?.requestId || null,
        source: "followup",
        reason: controlResult?.reason || "stale_navigation_result",
      });
      return res.status(200).json(buildLambdaCompatibleResponse({
        status: "pending",
        requestId: userInput?.requestId || null,
        payload_ready: false,
        answer_ready: false,
        voice_answer_source: "bridge",
        voice_answer: "",
        payload: null,
      }, {
        sessionHints: hints,
        status: "partial",
      }));
    }

    if (controlResult?.payload) {
      storeSession(username, controlResult.payload);
      emitQnaPayload(username, controlResult.payload, "updateVisuals");
      if (controlResult?.orchestrator?.fallbackReason) {
        routerLog("control", "navigation fallback used", {
          username,
          reason: controlResult.orchestrator.fallbackReason,
          bundleId: controlResult?.bundleId || null,
        });
      } else if (controlResult?.orchestrator?.stageGenerator === "replay_stored_stage") {
        routerLog("control", "navigation replayed stored stage", {
          username,
          stageIndex: controlResult?.stage?.stageIndex ?? null,
          bundleId: controlResult?.bundleId || null,
        });
      } else {
        routerLog("control", "navigation generated stage", {
          username,
          stageGenerator: controlResult?.orchestrator?.stageGenerator || null,
          stageIndex: controlResult?.stage?.stageIndex ?? null,
          bundleId: controlResult?.bundleId || null,
        });
      }
      emitStatus(
        username,
        "completed",
        controlResult?.orchestrator?.stageGenerator === "replay_stored_stage"
          ? "Showing your saved stage."
          : "Your stage is ready."
      );
      return res.status(200).json(buildLambdaCompatibleResponse({
        status: controlResult?.status || "ready",
        requestId: userInput?.requestId || null,
        payload_ready: true,
        answer_ready: Boolean(controlResult?.answerReady ?? controlResult.payload?.answer_ready ?? true),
        voice_answer_source: controlResult.payload?.voice_answer_source || controlResult?.voiceAnswerSource || "gpt",
        voice_answer: controlResult.payload?.voice_answer || controlResult?.voiceAnswer || "",
        payload: controlResult.payload,
      }, {
        payload: controlResult.payload,
        sessionHints: hints,
        status: Boolean(controlResult?.answerReady ?? controlResult.payload?.answer_ready ?? true)
          ? "complete"
          : "partial",
      }));
    }

    return res.status(200).json(buildLambdaCompatibleResponse({
      status: "error",
      requestId: userInput?.requestId || null,
      payload_ready: false,
      answer_ready: false,
      voice_answer_source: "fallback",
      voice_answer: controlResult?.voiceAnswer || "I could not move to that stage yet.",
      payload: null,
    }, {
      sessionHints: hints,
      status: "partial",
    }));
  }

  if (action === "accept_suggestion") {
    const session = getSession(username);
    const payload = session?.payload;
    const suggestionId = Number(userInput?.suggestionId || 0);
    const suggestion = payload?.next_views?.[suggestionId]?.label
      || payload?.suggestedDrillDowns?.[suggestionId]
      || payload?.suggested_follow_up?.[suggestionId];
    if (!payload || !suggestion) {
      return res.status(200).json(buildLambdaCompatibleResponse({
        status: "error",
        payload_ready: Boolean(payload),
        answer_ready: false,
        voice_answer_source: "fallback",
        voice_answer: "I do not have a follow-up suggestion ready.",
      }, {
        payload,
        sessionHints: hints,
      }));
    }
    const result = await answerFollowupFromPayload({ payload, question: suggestion });
    if (result?.payload) {
      storeSession(username, result.payload);
    }
    return res.status(200).json(buildLambdaCompatibleResponse({
      status: result?.answer_ready ? "ready" : "pending",
      payload_ready: Boolean(result?.payload),
      answer_ready: Boolean(result?.answer_ready),
      voice_answer_source: result?.voice_answer_source || "fallback",
      voice_answer: result?.answer_ready ? result.answer : "",
      suggestedQuestions: result.suggestedQuestions,
      payload: result.payload || payload,
    }, {
      payload: result?.payload || payload,
      sessionHints: hints,
    }));
  }

  return res.status(400).json({ error: `Unknown control action: ${action}` });
}

alexaRouter.get("/back", (req, res) => {
  const username = keyForUser(req.query?.username || "amy");
  qnaSession.delete(username);
  clearResumableJob(username);
  clearSessionState(username);
  emitToScreen(username, { action: "qnaEnd", reason: "user_done" });
  routerLog("session", "session cleared", { username });
  return res.status(200).json({ ok: true });
});

alexaRouter.post("/", async (req, res) => {
  const username = keyForUser(req.body?.username || "amy");
  const userInput = req.body?.userInput || {};
  const sessionHints = extractSessionHints(req.body, userInput);
  const type = String(userInput?.type || "").toLowerCase();

  routerLog("entry", "incoming request", {
    username,
    type,
    hasSessionHints: Boolean(sessionHints),
  });

  if (type === "question") return handleQuestion(username, userInput, res, sessionHints);
  if (type === "control") return handleControl(username, userInput, res, sessionHints);
  return res.status(400).json({ error: "userInput.type must be 'question' or 'control'" });
});

module.exports = alexaRouter;
module.exports._test = {
  buildLambdaCompatibleResponse,
  buildNoPendingResumeResponse,
  clearResumableJob,
  handleControl,
  handleQuestion,
  isCurrentResumableRequest,
  extractSessionHints,
  getJob,
  getResumableJob,
  startQuestionJob,
  syncBundleStateToLambdaShape,
  waitForJobSettlement,
  qnaJobs,
  qnaSession,
  resetState() {
    qnaJobs.clear();
    qnaSession.clear();
    resumableJobs.clear();
  },
  setResumableJob,
  syncResumableJob,
};
