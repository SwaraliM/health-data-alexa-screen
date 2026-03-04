const express = require("express");
const alexaRouter = express.Router();
const { getClients } = require("../websocket");
require("dotenv").config();
const { SYSTEM_CONFIG } = require("../configs/openAiSystemConfigs");
const { ENHANCED_VISUAL_CONFIG } = require("../configs/enhancedVisualConfigs");
const GPTChat = require("../GPTChat");
const User = require("../models/Users");
const Reminder = require("../models/Reminder");
const { parseReminderTextToRule, nextDateForRule, hasExplicitTime } = require("../services/reminderUtils");
const { generateSpeech } = require("../services/ttsService");

const apiKey = process.env.OPENAI_API_KEY;

if (!apiKey) {
  console.error("ERROR: OPENAI_API_KEY is not set in environment variables!");
  console.error("Please add OPENAI_API_KEY to your backend/.env file");
}

const gptChat = new GPTChat(apiKey, SYSTEM_CONFIG);
const enhancedVisualGPT = new GPTChat(apiKey, ENHANCED_VISUAL_CONFIG);

let state = "completed";
let gptRet = {};
let curUsername = "";
let lastTopic = null; // Store last topic for "Tell me more" follow-ups
const pendingReminderDrafts = new Map();
const qnaConversationState = new Map();
const ALEXA_DEADLINE_MS = 7000;
const INTERNAL_CUTOFF_MS = 6500;
const FETCH_TIMEOUT_MS = 3000;
let parseFallbackHitCount = 0;
let payloadFinalizeFallbackHitCount = 0;

function compressAlexaSpeech(text = "") {
  const source = String(text || "").trim();
  if (!source) return "Here is your quick summary.";
  const firstSentence = source.split(/[.!?]/).map((s) => s.trim()).find(Boolean) || source;
  const deFillered = firstSentence
    .replace(/\b(overall|generally|basically|in summary|to be honest|you can see that)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const words = deFillered.split(/\s+/).filter(Boolean).slice(0, 22).join(" ");
  if (words.length <= 140) return words;
  return `${words.slice(0, 137).trimEnd()}...`;
}

function clearQnaConversationState(username) {
  const key = String(username || "").toLowerCase();
  qnaConversationState.delete(key);
}

function safeSpeech(text = "", fallback = "Here is your quick health summary.") {
  const compressed = compressAlexaSpeech(text);
  if (!compressed || !compressed.trim()) return compressAlexaSpeech(fallback);
  return compressed;
}

function makeAlexaResponse(text, { shouldEndSession = false, repromptText = "" } = {}) {
  const speech = safeSpeech(text);
  const response = {
    version: "1.0",
    response: {
      outputSpeech: { type: "PlainText", text: speech },
      shouldEndSession,
    },
  };
  if (!shouldEndSession && repromptText) {
    response.response.reprompt = {
      outputSpeech: {
        type: "PlainText",
        text: safeSpeech(repromptText, "You can ask about the next chart or say done."),
      },
    };
  }
  return response;
}

function setQnaSessionState(username, payload, userContext = null, rawData = null) {
  const key = String(username || "").toLowerCase();
  qnaConversationState.set(key, {
    payload,
    activeStageIndex: Number.isFinite(payload?.activeStageIndex) ? payload.activeStageIndex : 0,
    updatedAt: new Date().toISOString(),
    userContext: userContext || null,
    rawData: rawData || null,
    lastQnaPayload: payload,
  });
}

function getQnaSessionState(username) {
  const key = String(username || "").toLowerCase();
  return qnaConversationState.get(key) || null;
}

function detectStageCommand(intentName = "", question = "", rawSlotValue = "") {
  const intent = String(intentName || "");
  const utterance = `${String(rawSlotValue || "")} ${String(question || "")}`.toLowerCase().trim();

  if (intent === "AMAZON.StopIntent" || intent === "AMAZON.CancelIntent") return "done";
  if (/\b(done|finish|end|exit|stop|go back|dashboard|close)\b/.test(utterance)) return "done";
  if (/\b(next|continue|forward|another|show next)\b/.test(utterance)) return "next";
  if (/\b(previous|back|prior|last chart|go back one)\b/.test(utterance)) return "previous";
  if (/\b(repeat|say that again|again|replay)\b/.test(utterance)) return "repeat";
  return null;
}

function isReminderCancelUtterance(utterance = "") {
  const u = String(utterance || "").toLowerCase().trim();
  return /\b(cancel|never mind|forget it|forget that|don't|dont|no thanks|no thank you|skip it|abort)\b/.test(u)
    || /^(no|nope|nah)$/.test(u);
}

function emitQnaStageSet(username, payload, stageIndex, cue = "", speech = "") {
  const clients = getClients();
  const clientSocket = clients.get(String(username || "").toLowerCase());
  if (!clientSocket) return;
  try {
    clientSocket.send(JSON.stringify({
      action: "qnaStageSet",
      stageIndex,
      cue,
      speech,
      data: payload,
    }));
  } catch (err) {
    console.error("Failed to emit qnaStageSet:", err.message);
  }
}

function deriveReminderVisualKey(title = "", category = "custom") {
  const lower = String(title || "").toLowerCase();
  if (category === "medication" || /\b(med|medicine|pill|tablet|capsule)\b/.test(lower)) return "pill";
  if (/\bdoctor|appointment|clinic|hospital\b/.test(lower)) return "doctor";
  if (/\bcardio|walk|run|exercise|workout|gym\b/.test(lower)) return "activity";
  if (/\bwater|hydrate|hydration\b/.test(lower)) return "hydration";
  if (/\bsleep|bed|nap\b/.test(lower)) return "sleep";
  return "bell";
}

const REMINDER_GENERIC_TITLES = ["a reminder", "reminder", "it", "that", "one"];

function isGenericReminderTitle(title = "") {
  const t = String(title || "").toLowerCase().trim();
  return !t || REMINDER_GENERIC_TITLES.includes(t);
}

function parseReminderIntent(question = "", draft = null) {
  const q = String(question || "").trim();
  const lower = q.toLowerCase();
  const verbMatched = /\b(remind|reminder|remember|alarm|schedule)\b/.test(lower) || Boolean(draft);
  if (!verbMatched) return null;

  // If we have a draft and know what we asked for, merge only that slot
  if (draft && (draft.askedFor === "title" || draft.askedFor === "time")) {
    let title = draft.title || "";
    let recurrenceText = draft.recurrenceText || "";
    if (draft.askedFor === "title") {
      title = q.replace(/\s+/g, " ").trim();
      recurrenceText = (draft.recurrenceText || "").trim();
    } else {
      recurrenceText = [draft.recurrenceText || "", q].filter(Boolean).join(" ").trim();
      title = draft.title || "";
    }
    const category = /\b(cardio|walk|run|exercise|workout)\b/i.test(recurrenceText)
      ? "activity"
      : (draft.category || "custom");
    const missing = [];
    if (!title || isGenericReminderTitle(title)) missing.push("title");
    if (!hasExplicitTime(recurrenceText)) missing.push("time");
    return {
      title: isGenericReminderTitle(title) ? "" : title,
      recurrenceText,
      category,
      missing,
    };
  }

  const cleaned = q
    .replace(/^set\s+(a\s+)?(reminder|alarm)\s+(to\s+)?/i, "")
    .replace(/^create\s+(a\s+)?reminder\s+(to\s+)?/i, "")
    .replace(/^remind me to\s+/i, "")
    .replace(/^remind me\s+/i, "")
    .trim();

  const inferredTime = hasExplicitTime(cleaned) ? cleaned : "";
  const inferredTitle = cleaned
    .replace(/\b(every|daily|weekdays|weekly|monthly|tomorrow|today|at|am|pm|morning|afternoon|evening|night)\b/gi, "")
    .replace(/\b(\d{1,2})(?::\d{2})?\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  let title = inferredTitle || draft?.title || "";
  if (isGenericReminderTitle(title)) title = "";
  const recurrenceText = [draft?.recurrenceText || "", cleaned].filter(Boolean).join(" ").trim();
  const category = /\b(cardio|walk|run|exercise|workout)\b/i.test(recurrenceText)
    ? "activity"
    : (draft?.category || "custom");

  const missing = [];
  if (!title) missing.push("title");
  if (!hasExplicitTime(recurrenceText) && !inferredTime) missing.push("time");

  return {
    title,
    recurrenceText,
    category,
    missing,
  };
}

async function createReminderFromAlexa(username, parsed) {
  const rule = parseReminderTextToRule(parsed.recurrenceText, new Date());
  const nextTriggerAt = nextDateForRule(rule, new Date());
  const reminder = await Reminder.create({
    username,
    title: parsed.title,
    category: parsed.category,
    source: "alexa",
    schedule: {
      timezone: "America/New_York",
      rules: [rule],
    },
    payload: {
      suggestion: parsed.recurrenceText,
      voicePromptTemplate: `Reminder: ${parsed.title}`,
      visualKey: deriveReminderVisualKey(parsed.title, parsed.category),
    },
    delivery: {
      popup: true,
      alexaVoice: true,
    },
    status: "active",
    nextTriggerAt,
  });
  return reminder;
}

function normalizeFrontendPayload(frontend, fallbackResponse) {
  const fallbackSpeech = safeSpeech(fallbackResponse, "Here is your quick health summary.");
  if (!frontend || typeof frontend !== "object") {
    return {
      question: "How did I do this week?",
      summary: {
        shortSpeech: fallbackSpeech,
        shortText: fallbackResponse || fallbackSpeech,
      },
      stages: [],
      activeStageIndex: 0,
      suggestedQuestions: ["What changed this week?", "Show the next chart"],
    };
  }

  const baseComponents = Array.isArray(frontend.components) ? frontend.components : [];
  const allStageCandidates = Array.isArray(frontend.stages) ? frontend.stages : [];
  const synthesizedStages = baseComponents.map((component, index) => ({
    id: `stage_${index + 1}`,
    cue: index === 0 ? "Here is your first chart." : `Here is chart ${index + 1}.`,
    components: [component],
  }));
  const stageSource = allStageCandidates.length > 0 ? allStageCandidates : synthesizedStages;

  const normalizedStages = stageSource
    .map((stage, index) => {
      const components = Array.isArray(stage?.components) ? stage.components.filter(Boolean) : [];
      const firstComponent = components[0] || null;
      if (!firstComponent) return null;
      const cue = String(stage?.cue || `Here is chart ${index + 1}.`);
      const stageSpeech = safeSpeech(stage?.speech || cue || fallbackSpeech, fallbackSpeech);
      const dataStatus = stage?.dataStatus || (componentHasRenderableData(firstComponent) ? "ok" : "partial");
      return {
        id: stage?.id || `stage_${index + 1}`,
        cue,
        speech: stageSpeech,
        dataStatus,
        components: [firstComponent],
      };
    })
    .filter(Boolean)
    .slice(0, 3);

  const shortText = frontend.summary?.shortText || fallbackResponse || fallbackSpeech;
  const shortSpeech = safeSpeech(frontend.summary?.shortSpeech || shortText, fallbackSpeech);
  const activeStageIndexRaw = Number(frontend.activeStageIndex);
  const activeStageIndex = Number.isFinite(activeStageIndexRaw)
    ? Math.min(Math.max(activeStageIndexRaw, 0), Math.max(0, normalizedStages.length - 1))
    : 0;

  return {
    question: frontend.question || "Health update",
    summary: {
      shortSpeech,
      shortText,
    },
    stages: normalizedStages,
    activeStageIndex,
    suggestedQuestions: Array.isArray(frontend.suggestedQuestions) && frontend.suggestedQuestions.length > 0
      ? frontend.suggestedQuestions.slice(0, 4)
      : ["What changed this week?", "Show the next chart", "How can I improve this?"],
  };
}

function componentHasRenderableData(component) {
  if (!component || typeof component !== "object") return false;
  const data = component.data || {};
  if (!data || typeof data !== "object") return false;
  if (Array.isArray(data.data) && data.data.length > 0) return true;
  if (Array.isArray(data.points) && data.points.length > 0) return true;
  if (Array.isArray(data.series?.points) && data.series.points.length > 0) return true;
  if (typeof data.value === "number") return true;
  if (typeof data.current === "number" && typeof data.goal === "number") return true;
  if (Array.isArray(data.list) && data.list.length > 0) return true;
  return false;
}

function hasRenderableVisual(payload) {
  if (!payload || typeof payload !== "object") return false;
  const stageComponents = Array.isArray(payload.stages)
    ? payload.stages.flatMap((stage) => (Array.isArray(stage?.components) ? stage.components : []))
    : [];
  const topComponents = Array.isArray(payload.components) ? payload.components : [];
  return stageComponents.length > 0 || topComponents.length > 0;
}

function findFirstArrayByKey(rawData, keyPattern) {
  if (!rawData || typeof rawData !== "object") return null;
  for (const value of Object.values(rawData)) {
    if (!value || typeof value !== "object") continue;
    for (const [key, arr] of Object.entries(value)) {
      if (keyPattern.test(key) && Array.isArray(arr) && arr.length > 0) return arr;
    }
  }
  return null;
}

function buildFallbackVisualPayload(rawData, fallbackResponse = "Here is your quick health summary.", question = "Health update") {
  const speech = safeSpeech(fallbackResponse, "Here is your quick health summary.");
  const stepsSeriesRaw = findFirstArrayByKey(rawData, /^activities-steps$/i);
  const heartSeriesRaw = findFirstArrayByKey(rawData, /^activities-heart$/i);

  const sleepLog = (() => {
    if (!rawData || typeof rawData !== "object") return null;
    for (const value of Object.values(rawData)) {
      if (Array.isArray(value?.sleep) && value.sleep.length > 0) return value.sleep[0];
    }
    return null;
  })();

  const stepsSeries = Array.isArray(stepsSeriesRaw)
    ? stepsSeriesRaw
      .map((d) => ({ date: String(d?.dateTime || ""), steps: Number(d?.value || 0) }))
      .filter((d) => d.date && Number.isFinite(d.steps))
    : [];

  const heartSeries = Array.isArray(heartSeriesRaw)
    ? heartSeriesRaw
      .map((d) => ({ date: String(d?.dateTime || ""), restingHeartRate: Number(d?.value?.restingHeartRate ?? d?.value ?? NaN) }))
      .filter((d) => d.date && Number.isFinite(d.restingHeartRate))
    : [];

  const sleepMinutes = Number(sleepLog?.minutesAsleep ?? 0);
  if (sleepMinutes > 0) {
    const sleepHours = Math.round((sleepMinutes / 60) * 10) / 10;
    const stageSpeech = safeSpeech(`You slept ${sleepHours} hours. Here is your sleep chart.`, speech);
    return {
      question,
      summary: { shortSpeech: speech, shortText: fallbackResponse || speech },
      stages: [{
        id: "fallback_stage_sleep",
        cue: "Here is your sleep snapshot.",
        speech: stageSpeech,
        dataStatus: "ok",
        components: [{
          component: "CustomPie",
          data: {
            title: "Sleep vs Goal",
            data: [{ type: "Asleep", value: sleepHours }, { type: "Goal", value: 8 }],
            insight: `You slept ${sleepHours} hours last night.`,
          },
          explanationTitle: "Sleep snapshot",
          explanationText: `You slept ${sleepHours} hours compared with your 8-hour goal.`,
          explanationBullets: [
            "Main finding: Sleep duration is compared to your goal.",
            "Why it matters: Regular sleep supports memory and attention.",
            "One action: Keep bedtime consistent tonight.",
          ],
        }],
      }],
      activeStageIndex: 0,
      suggestedQuestions: ["Show the next chart", "How does this compare to last week?"],
    };
  }

  if (stepsSeries.length > 0) {
    const stageSpeech = safeSpeech("Here is your recent steps trend.", speech);
    return {
      question,
      summary: { shortSpeech: speech, shortText: fallbackResponse || speech },
      stages: [{
        id: "fallback_stage_steps",
        cue: "Here is your recent steps trend.",
        speech: stageSpeech,
        dataStatus: "ok",
        components: [{
          component: "CustomLineChart",
          data: {
            title: "Steps Trend",
            data: stepsSeries.slice(-7),
            xLabel: "Date",
            yLabel: "Steps",
            insight: "This chart shows your recent daily steps.",
          },
          explanationTitle: "Steps trend",
          explanationText: "This chart shows your day-to-day step pattern.",
          explanationBullets: [
            "Main finding: Daily steps are shown over recent days.",
            "Why it matters: Consistent movement supports overall health.",
            "One action: Add a short walk at the same time each day.",
          ],
        }],
      }],
      activeStageIndex: 0,
      suggestedQuestions: ["Show the next chart", "Why did my steps change?"],
    };
  }

  if (heartSeries.length > 0) {
    const stageSpeech = safeSpeech("Here is your resting heart trend.", speech);
    return {
      question,
      summary: { shortSpeech: speech, shortText: fallbackResponse || speech },
      stages: [{
        id: "fallback_stage_heart",
        cue: "Here is your resting heart trend.",
        speech: stageSpeech,
        dataStatus: "partial",
        components: [{
          component: "CustomLineChart",
          data: {
            title: "Resting Heart Rate",
            data: heartSeries.slice(-7),
            xLabel: "Date",
            yLabel: "BPM",
            insight: "This chart shows your resting heart rate trend.",
          },
          explanationTitle: "Resting heart trend",
          explanationText: "This chart tracks your resting heart rate across recent days.",
        }],
      }],
      activeStageIndex: 0,
      suggestedQuestions: ["Show the next chart", "Is this trend healthy?"],
    };
  }

  return {
    question,
    summary: { shortSpeech: speech, shortText: fallbackResponse || speech },
    stages: [{
      id: "fallback_stage_value",
      cue: "Here is your health summary tile.",
      speech: safeSpeech("I could not load enough Fitbit data right now, but here is your latest available summary.", speech),
      dataStatus: "missing",
      components: [{
        component: "SingleValue",
        data: { title: "Health Update", value: 1, unit: "summary", insight: fallbackResponse },
        explanationTitle: "Summary tile",
        explanationText: "This tile confirms your latest health summary.",
      }],
    }],
    activeStageIndex: 0,
    suggestedQuestions: ["Try again in a moment", "Ask about a specific metric"],
  };
}

function ensureRenderableVisualPayload(frontendPayload, rawData, fallbackResponse, question) {
  const normalized = normalizeFrontendPayload(frontendPayload, fallbackResponse);
  if (hasRenderableVisual(normalized)) return normalized;
  return buildFallbackVisualPayload(rawData, fallbackResponse, question);
}

function buildFailSafeQnaPayload(question, rawData, userContext) {
  const stepGoal = Number(userContext?.preferences?.dailyStepGoal || 10000);
  const fallbackResponse = `I could not load full Fitbit details. Here is a safe summary using your latest available data toward ${stepGoal} steps.`;
  const payload = buildFallbackVisualPayload(rawData, fallbackResponse, question || "Health update");
  const stages = Array.isArray(payload.stages) ? payload.stages : [];
  if (stages.length === 0) {
    payload.stages = [{
      id: "stage_1",
      cue: "Here is your quick summary tile.",
      speech: safeSpeech("I could not load enough Fitbit data right now, but here is your latest available summary.", fallbackResponse),
      dataStatus: "missing",
      components: [{
        component: "SingleValue",
        data: {
          title: "Health Update",
          value: 1,
          unit: "summary",
          insight: fallbackResponse,
        },
      }],
    }];
  }
  payload.activeStageIndex = 0;
  return payload;
}

function isLikelyJsonObjectString(text = "") {
  const trimmed = String(text || "").trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}");
}

function extractBoundedObject(text = "") {
  const source = String(text || "");
  const start = source.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return source.slice(start, i + 1);
  }
  return null;
}

function quoteUnquotedObjectKeys(text = "") {
  return String(text || "").replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, "$1\"$2\":");
}

function safeParseModelJson(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw !== "string") return null;

  const cleaned = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const attempts = [
    cleaned,
    quoteUnquotedObjectKeys(cleaned),
    extractBoundedObject(cleaned),
    quoteUnquotedObjectKeys(extractBoundedObject(cleaned) || ""),
  ].filter(Boolean);

  for (const candidate of attempts) {
    if (!isLikelyJsonObjectString(candidate)) continue;
    try {
      return JSON.parse(candidate);
    } catch (_) {}
  }

  parseFallbackHitCount += 1;
  console.warn(`[QnA Parse Fallback] hit=${parseFallbackHitCount}`);
  return null;
}

function finalizeQnaPayload(result, question, userContext, rawData) {
  const fallbackResponse = result?.data?.response || "I had trouble loading that, but here is a safe summary chart.";
  const candidateFrontend = result?.type === "present" ? result?.data?.frontend : null;
  const candidateRawData = rawData || result?._rawData || null;

  let payload = candidateFrontend
    ? ensureRenderableVisualPayload(candidateFrontend, candidateRawData, fallbackResponse, question)
    : buildFailSafeQnaPayload(question, candidateRawData, userContext);

  if (!hasRenderableVisual(payload)) {
    payload = buildFailSafeQnaPayload(question, candidateRawData, userContext);
  }

  const stages = Array.isArray(payload?.stages) ? payload.stages : [];
  if (stages.length === 0) {
    payload = buildFailSafeQnaPayload(question, candidateRawData, userContext);
  }

  if (!candidateFrontend || !hasRenderableVisual(payload)) {
    payloadFinalizeFallbackHitCount += 1;
    console.warn(`[QnA Finalize Fallback] hit=${payloadFinalizeFallbackHitCount}`);
  }

  const finalizedStages = Array.isArray(payload?.stages) ? payload.stages : [];
  const clampedStageIndex = finalizedStages.length > 0
    ? Math.min(Math.max(Number(payload?.activeStageIndex) || 0, 0), finalizedStages.length - 1)
    : 0;
  const stage = finalizedStages[clampedStageIndex] || null;
  const summaryShortSpeech = safeSpeech(payload?.summary?.shortSpeech || payload?.summary?.shortText || fallbackResponse, fallbackResponse);
  payload = {
    ...payload,
    activeStageIndex: clampedStageIndex,
    summary: {
      shortSpeech: summaryShortSpeech,
      shortText: payload?.summary?.shortText || fallbackResponse,
    },
  };

  const stageSpeech = safeSpeech(stage?.speech || stage?.cue || summaryShortSpeech, summaryShortSpeech);
  return {
    payload,
    stageSpeech,
    rawData: candidateRawData,
  };
}

function getStageAtIndex(payload, stageIndex) {
  const stages = Array.isArray(payload?.stages) ? payload.stages : [];
  if (stages.length === 0) return null;
  const clamped = Math.min(Math.max(stageIndex, 0), stages.length - 1);
  return { stage: stages[clamped], index: clamped };
}

alexaRouter.get("/", (req, res) => {
  console.log("current user: " + curUsername);
  if (state === "processing") {
    //still processing
    return res.status(200).json({
      state: state,
      message: "Welcome to Alexa Router"
    });
  }
  //if state is completed
  const clients = getClients();
  const clientSocket = clients.get(curUsername);
  if (gptRet.type == "close") {
    const curGptRet = gptRet;
    console.log("close");
    gptChat.clearHistory();
    if (curUsername && clients.has(curUsername) && clientSocket) {
      const message = {
        action: "navigation",
        option: "/dashboard",
        data: {},
      };

      clientSocket.send(JSON.stringify(message));

      console.log(`Sent message to ${curUsername}:`, JSON.stringify(message));

    }
    gptRet = {};
    

    return res.status(200).json({
      state: state,
      message: curGptRet.data
    });
  } else if (gptRet.type == "reInput") {
    const curGptRet = gptRet;

    console.log("reInput");
    gptRet = {};

    return res.status(200).json({
      state: state,
      message: curGptRet.data
    });
  } else if (gptRet.type == "present") {
    const curGptRet = gptRet;
    console.log("present");

    if (curUsername && clients.has(curUsername) && clientSocket) {
      const frontendPayload = ensureRenderableVisualPayload(
        curGptRet.data.frontend,
        curGptRet._rawData,
        curGptRet.data.response,
        curGptRet.data?.frontend?.question || "Health update"
      );
      const message = {
        action: "navigation",
        option: "/qna",
        data: frontendPayload,
      };

      clientSocket.send(JSON.stringify(message));
      setQnaSessionState(curUsername, frontendPayload, null, curGptRet._rawData || null);
      const firstStage = getStageAtIndex(frontendPayload, frontendPayload.activeStageIndex || 0);
      if (firstStage?.stage) {
        emitQnaStageSet(curUsername, frontendPayload, firstStage.index, firstStage.stage.cue || "", firstStage.stage.speech || "");
      }

      console.log(`Sent message to ${curUsername}:`, JSON.stringify(message));

    }
    return res.status(200).json({
      state: state,
      message: safeSpeech(curGptRet.data.response || curGptRet.data.summary?.shortSpeech || "Here is your chart.")
    });
  } else {

    console.log("unknow error");

    return res.status(200).json({
      state: state,
      message: "I didn't catch that, could you repeat your question?"
    });
  }

});


function parseJSONResponse(response) {
  return safeParseModelJson(response);
}

async function callGPT(input) {
  console.log("callGPT");
  try {
    // No token limit - let GPT use full context window
    // Pass null to allow unlimited response length
    const maxTokens = null;
    
    let reply = await gptChat.callGPT(input, "gpt-5.1", maxTokens);
    console.log("98 reply: " + JSON.stringify(reply));

    // Use improved JSON parsing with cleaning
    let replyJson = parseJSONResponse(reply);
    if (!replyJson || typeof replyJson !== "object" || !replyJson.type) {
      return { type: "error", data: "Model returned malformed JSON." };
    }


    if (replyJson.type == "fetch") {
      const fetchedData = await fetchData(replyJson.data, curUsername);
      console.log("======" + fetchedData);

      const newInput = { type: "rawData", data: fetchedData };

      // Use higher token limit for data processing
      replyJson = await callGPT(newInput);
      
      // Store raw data for enhanced visualization
      if (replyJson && replyJson.type === "present") {
        replyJson._rawData = fetchedData;
      }
    }

    return replyJson;
  } catch (error) {
    console.error("error here:" + error.message);
    
    // Return a concise error message
    if (error.message.includes("timeout")) {
      return { type: "error", data: "That took too long. Please try a simpler question." };
    }
    
    return { type: "error", data: "Sorry, I didn't catch that. Could you repeat your question?" };
  }
}


async function fetchData(queryUrls, username) {
  const urls = Array.isArray(queryUrls) ? queryUrls : [];
  console.log("url number: " + urls.length);
  const combinedData = {}; // using object to store return data

  // Use localhost for internal API calls instead of API_URL (which may be ngrok URL)
  const internalApiUrl = process.env.INTERNAL_API_URL || 'http://localhost:5001';

  const fetchWithTimeout = async (url) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { method: "GET", signal: controller.signal });
      if (!response.ok) {
        const errorText = await response.text();
        return { error: `Status ${response.status}: ${errorText || response.statusText}` };
      }
      const data = await response.json();
      return data;
    } catch (error) {
      const message = error?.name === "AbortError" ? "Fetch timeout" : (error.message || "Fetch failed");
      return { error: message };
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const requests = urls.map((queryUrl) => {
    const url = `${internalApiUrl}/api/fitbit/${username}${queryUrl}`;
    return { url, promise: fetchWithTimeout(url) };
  });

  const settled = await Promise.allSettled(requests.map((r) => r.promise));
  settled.forEach((result, index) => {
    const { url } = requests[index];
    if (result.status === "fulfilled") {
      combinedData[url] = result.value;
      if (result.value?.error) {
        console.error("Fetch error for", url, ":", result.value.error);
      } else {
        console.log(`Successfully fetched data from ${url}`);
      }
    } else {
      combinedData[url] = { error: result.reason?.message || "Fetch failed" };
      console.error("Fetch error for", url, ":", result.reason?.message || "Fetch failed");
    }
  });

  return combinedData;
}

// Generate enhanced visualizations asynchronously
async function generateEnhancedVisuals(rawData, userContext, username) {
  try {
    console.log("Generating enhanced visuals...");
    
    const clients = getClients();
    const clientSocket = clients.get(username);
    
    // Send status message to frontend
    if (clientSocket) {
      const statusMessage = {
        action: "status",
        message: "I am creating visuals for you, it might take a moment.",
        type: "generating"
      };
      clientSocket.send(JSON.stringify(statusMessage));
      console.log(`Sent status message to ${username}: Generating visuals`);
    }
    
    // Create input for enhanced visualization GPT
    const enhancedInput = {
      type: "enhancedVisual",
      data: rawData,
      userContext: userContext
    };
    
    // Call GPT with enhanced config (longer timeout, more tokens)
    // Increased timeout to 90 seconds for complex visualizations
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("Enhanced visualization timeout")), 90000); // 90 second timeout
    });
    
    if (clientSocket) {
      const analysisStatus = {
        action: "status",
        message: "Analyzing your health data...",
        type: "generating"
      };
      clientSocket.send(JSON.stringify(analysisStatus));
    }

    let enhancedReply;
    try {
      enhancedReply = await Promise.race([
        enhancedVisualGPT.callGPT(enhancedInput, "gpt-5.1", null),
        timeoutPromise
      ]);
    } catch (timeoutError) {
      console.error("Enhanced visualization timeout:", timeoutError.message);
      // Send error status
      if (clientSocket) {
        const errorMessage = {
          action: "status",
          message: "Visual generation took too long. Showing basic visuals instead.",
          type: "error"
        };
        clientSocket.send(JSON.stringify(errorMessage));
      }
      return null;
    }
    
    console.log("Enhanced visual reply:", enhancedReply);

    if (clientSocket) {
      clientSocket.send(JSON.stringify({
        action: "status",
        message: "Building your charts...",
        type: "generating"
      }));
    }

    const enhancedJson = parseJSONResponse(enhancedReply);
    
    if (enhancedJson.type === "present" && enhancedJson.data && enhancedJson.data.frontend) {
      const safeEnhancedFrontend = ensureRenderableVisualPayload(
        normalizeFrontendPayload(enhancedJson.data.frontend, "Enhanced visuals are ready."),
        rawData,
        "Enhanced visuals are ready.",
        enhancedJson.data.frontend?.question || "Health update"
      );
      const stages = Array.isArray(safeEnhancedFrontend.stages) ? safeEnhancedFrontend.stages : [];
      const deep = safeEnhancedFrontend.deepAnalysis;
      const deepComps = Array.isArray(deep?.components) ? deep.components : [];
      const stageComps = stages.flatMap((s) => (Array.isArray(s?.components) ? s.components : []));
      const allComponents = [...stageComps, ...deepComps].map((c) => ({
        ...c,
        chartSummary: c.chartSummary || c.data?.chartSummary || c.data?.insight || c.data?.title || "Detailed view of your health data.",
      }));
      const enhancedVisuals = {
        summary: safeEnhancedFrontend.summary?.shortText || deep?.interpretation || "Here is a deeper look at your health data.",
        components: allComponents,
      };
      const voiceNarration = (safeEnhancedFrontend.voiceNarration || enhancedJson.data.frontend?.voiceNarration || "").trim();
      let narrationAudio = null;
      let narrationText = voiceNarration || null;
      if (voiceNarration) {
        try {
          narrationAudio = await generateSpeech(voiceNarration);
        } catch (ttsErr) {
          console.error("Enhanced visuals TTS failed:", ttsErr.message);
        }
      }
      if (clientSocket) {
        const enhancedMessage = {
          action: "updateVisuals",
          data: {
            enhancedVisuals,
            ...(narrationAudio && { narrationAudio }),
            ...(narrationText && { narrationText }),
          },
        };
        clientSocket.send(JSON.stringify(enhancedMessage));
        console.log(`Sent enhanced visuals update to ${username}`);

        const completeStatus = {
          action: "status",
          message: "Enhanced visuals are ready.",
          type: "completed",
        };
        clientSocket.send(JSON.stringify(completeStatus));
      }

      return safeEnhancedFrontend;
    }
    
    return null;
  } catch (error) {
    console.error("Error generating enhanced visuals:", error.message);
    
    // Send error status to frontend
    const clients = getClients();
    const clientSocket = clients.get(username);
    if (clientSocket) {
      const errorMessage = {
        action: "status",
        message: "Could not generate enhanced visuals. Basic visuals are shown.",
        type: "error"
      };
      clientSocket.send(JSON.stringify(errorMessage));
    }
    
    return null;
  }
}

// alexaRouter.post("/", async (req, res) => {
//   const timeoutPromise = new Promise((resolve) => {
//     setTimeout(() => {
//       resolve({ timeout: true });
//     }, 7000); // timeout limit 7 seconds
//   });
//   const mainLogicPromise = (async () => {
//     let { userInput, username } = req.body;
//     console.log("Recevied Post request from Alexa========");
//     console.log(JSON.stringify(userInput));
//     console.log(JSON.stringify(username));
//     username = username.toLowerCase();

//     const clients = getClients();
//     const clientSocket = clients.get(username);

//     if (ifWaitQuestion && userInput.data && userInput.data.toLowerCase().includes("yes")) {
//       //user want to wait
//       if (
//         asyncResults.has(username) &&
//         (asyncResults.get(username) == null || asyncResults.get(username).data == null)
//       ) {
//         console.log("line80: " );
//         console.log(Object.fromEntries(asyncResults));
//         asyncResults.clear();
//         ifWaitQuestion = false;
//         if (username && clients.has(username) && clientSocket) {
//           const message = {
//             action: "navigation",
//             option: "/dashboard",
//             data: {},
//           };

//           clientSocket.send(JSON.stringify(message));
//           console.log(`Sent message to ${username}:`, JSON.stringify(message));
//         }

//         return { timeout: false, data: { message: "Sorry, I didn’t catch that. Could you repeat your question?" } };
//       }

//       if (asyncResults.has(username) && asyncResults.get(username) !== null) {
//         console.log("line98: ");
//         console.log(Object.fromEntries(asyncResults));
//         const currentAsyncResult = asyncResults.get(username);
//         console.log("current " + currentAsyncResult)
//         asyncResults.delete(username);
//         console.log("line102: ");
//         console.log(Object.fromEntries(asyncResults));

//         if (username && clients.has(username) && clientSocket) {
//           const message = {
//             action: "navigation",
//             option: "/qna",
//             data: currentAsyncResult.data.frontend,
//           };

//           clientSocket.send(JSON.stringify(message));

//           console.log(`Sent message to ${username}:`, JSON.stringify(message));
//         }

//         ifWaitQuestion = false;
//         return { timeout: false, data: { message: currentAsyncResult.data.response } };


//       } else {
//         const start = Date.now();
//         while (Date.now() - start < 6500) {
//           //block for 6.5 seconds
//         }
//         if (asyncResults.has(username) && asyncResults.get(username) !== null) {
//           console.log("line126: ");
//           console.log(Object.fromEntries(asyncResults));
//           return { timeout: false, data: asyncResults.get(username) };
//         } else {
//           return { timeout: true };
//         }
//       }
//     } else if (ifWaitQuestion) {
//       //use don't want to wait
//       ifWaitQuestion = false;
//       ifAbandon = true;
//       console.log("line136: " );
//       console.log(Object.fromEntries(asyncResults));
//       asyncResults.clear();

//       if (username && clients.has(username) && clientSocket) {
//         const message = {
//           action: "navigation",
//           option: "/dashboard",
//           data: {},
//         };

//         clientSocket.send(JSON.stringify(message));
//         console.log(`Sent message to ${username}:`, JSON.stringify(message));
//       }

//       return { timeout: false, data: { message: "sorry for processing so long, back to dashboard for you" } };
//     }


//     ifAbandon = false;
//     const gptRet = await callGPT(userInput);
//     if (!gptRet || typeof gptRet.type === "undefined") {
//       return { timeout: false, data: { message: "Sorry, I didn’t catch that. Could you repeat your question?" } }
//     }
//     if (gptRet.type == "close") {
//       console.log("close");
//       gptChat.clearHistory();
//       if (ifWaitQuestion) {
//         console.log("line160: ");
//         console.log(Object.fromEntries(asyncResults));
//         asyncResults.set(username, gptRet);
//         return { timeout: false };
//       }
//       if (ifAbandon) {
//         console.log("line165: " );
//         console.log(Object.fromEntries(asyncResults));
//         asyncResults.clear();
//         return { timeout: false, data: {} }
//       }
//       if (username && clients.has(username) && clientSocket) {
//         const message = {
//           action: "navigation",
//           option: "/dashboard",
//           data: {},
//         };

//         clientSocket.send(JSON.stringify(message));

//         console.log(`Sent message to ${username}:`, JSON.stringify(message));

//         ifWaitQuestion = false;
//         return { timeout: false, data: { message: gptRet.data } };
//       }
//     } else if (gptRet.type == "reInput") {

//       if (ifWaitQuestion) {
//         console.log("line186: ");
//         console.log(Object.fromEntries(asyncResults));
//         asyncResults.set(username, gptRet);
//         return { timeout: false };
//       }

//       if (ifAbandon) {
//         console.log("line192: ");
//         console.log(Object.fromEntries(asyncResults));
//         asyncResults.clear();
//         return { timeout: false, data: {} }
//       }

//       console.log("reInput");
//       ifWaitQuestion = false;
//       return { timeout: false, data: { message: gptRet.data } };
//     } else if (gptRet.type == "fetch") {
//       console.log("fetch");
//       const fetchedData = await fetchData(gptRet.data, username);
//       console.log("======" + fetchedData);
//       const newInput = { "type": "rawData", "data": fetchedData };
//       const gptRetAfterFetch = await callGPT(newInput);

//       if (ifWaitQuestion) {
//         console.log("line208: ");
//         console.log(Object.fromEntries(asyncResults));
//         asyncResults.set(username, gptRetAfterFetch);
//         console.log("mark1")
//         return { timeout: false };
//       }

//       if (ifAbandon) {
//         console.log("line215: ");
//         console.log(Object.fromEntries(asyncResults));
//         asyncResults.clear();
//         console.log("mark2")
//         return { timeout: false, data: {} }
//       }

//       if (username && clients.has(username) && clientSocket) {
//         const message = {
//           action: "navigation",
//           option: "/qna",
//           data: gptRetAfterFetch.data.frontend,
//         };

//         clientSocket.send(JSON.stringify(message));

//         console.log(`Sent message to ${username}:`, JSON.stringify(message));

//         ifWaitQuestion = false;
//         console.log("mark3")
//         return { timeout: false, data: { message: gptRetAfterFetch.data.response } };
//       }
//     } else if (gptRet.type == "present") {
//       console.log("present");

//       if (ifWaitQuestion) {
//         console.log("line240: ");
//         console.log(Object.fromEntries(asyncResults));
//         asyncResults.set(username, gptRet);
//         return { timeout: false };
//       }

//       if (ifAbandon) {
//         console.log("line246: ");
//         console.log(Object.fromEntries(asyncResults));
//         asyncResults.clear();
//         return { timeout: false, data: {} }
//       }

//       if (username && clients.has(username) && clientSocket) {
//         const message = {
//           action: "navigation",
//           option: "/qna",
//           data: gptRet.data.frontend,
//         };

//         clientSocket.send(JSON.stringify(message));

//         console.log(`Sent message to ${username}:`, JSON.stringify(message));

//         ifWaitQuestion = false;
//         return { timeout: false, data: { message: gptRet.data.response } };
//       }
//     } else {

//       if (ifWaitQuestion) {
//         console.log("line268: ");
//         console.log(Object.fromEntries(asyncResults));
//         asyncResults.set(username, gptRet);
//         return { timeout: false };
//       }

//       if (ifAbandon) {
//         console.log("line274: ");
//         console.log(Object.fromEntries(asyncResults));
//         asyncResults.clear();
//         return { timeout: false, data: {} }
//       }

//       console.log("unknow");

//       ifWaitQuestion = false;
//       return { timeout: false, data: { message: "error" } };
//     }
//   })();

//   const result = await Promise.race([mainLogicPromise, timeoutPromise]);

//   console.log("288Result is:")
//   console.log(JSON.stringify(result, null, 2));

//   console.log("result: " + result);

//   if (result.timeout) {
//     ifWaitQuestion = true;
//     ifAbandon = false;
//     return res.status(200).json({ message: "It is taking me a bit longer , we still need time to processe, do you want to wait?" });
//   } else {
//     ifWaitQuestion = false;
//     return res.status(200).json(result.data);
//   }



//   // try {
//   //   const gptRet = await callGPT(userInput);


//   //   const clients = getClients();
//   //   if (analysis === "back") {
//   //     const clientSocket = clients.get(username);
//   //     if (username && clients.has(username) && clientSocket) {
//   //       const message = {
//   //         action: "navigation",
//   //         option: "/dashboard",
//   //         data: {},
//   //       };

//   //       clientSocket.send(JSON.stringify(message));

//   //       console.log(`Sent message to ${username}:`, JSON.stringify(message));
//   //     }
//   //     return res.status(200).json({ message: "returned to the dashboard" });
//   //   }

//   //   if (analysis.completed == false) {
//   //     return res.status(200).json({ message: analysis.next });
//   //   }

//   //   console.log("=======analysis completed===========");

//   //   // // Step2: fetch data
//   //   const combinedData = await fetchData(analysis.next, username);

//   //   console.log("=======fetch completed===========");

//   //   // Step3: Get General Response to alexa
//   //   const alexaResponse = await getAlexaResponse(combinedData);
//   //   console.log("alexa Response: " + alexaResponse);
//   //   res.status(200).json({ message: alexaResponse });

//   //   console.log("=======response returned===========");

//   //   //Step4: send stuctured display data and analysis to frontend using websocket

//   //   if (!username || !clients.has(username)) {
//   //     return;
//   //   }

//   //   //TODO
//   //   const fetchedDataWithQuestion = {
//   //     question: analysis.question,
//   //     data: combinedData,
//   //   };
//   //   console.log(JSON.stringify(fetchedDataWithQuestion, null, 2));

//   //   const processedData = await processData(combinedData);

//   //   console.log("=======process completed===========");

//   //   const clientSocket = clients.get(username);
//   //   if (clientSocket) {
//   //     const message = processedData;

//   //     clientSocket.send(JSON.stringify(message));

//   //     console.log(`Sent message to ${username}:`, JSON.stringify(message));

//   //     return;
//   //   }
//   // } catch (error) {
//   //   console.error(error);
//   // }

//   // const clients = getClients();

//   // if (!username || !clients.has(username)) {
//   //     return res.status(400).json({ message: "No client connected with the given username." });
//   // }

//   // const clientSocket = clients.get(username);

//   // //call gpt to interpret voice input
//   // //voice input -gpt-> what endpoint should be reached
//   // //get data from api call -gpt-> analysis, stuctured data, response
//   // //response to alexa, ws to frontend(analysis and data)

//   // if (clientSocket) {
//   //     const message = {
//   //         command: command,
//   //         options: options
//   //     };

//   //     clientSocket.send(JSON.stringify(message));

//   //     console.log(`Sent message to ${username}:`, JSON.stringify(message));

//   //     return res.status(200).json({ message: "Command sent successfully" });
//   // } else {
//   //     return res.status(500).json({ message: "Failed to send command to client." });
//   // }
// });

alexaRouter.post("/", async (req, res) => {
  console.log("Received request from Alexa========");
  console.log("Request body:", JSON.stringify(req.body, null, 2));

  // Check if this is a direct Alexa request or Lambda-formatted request
  const isAlexaRequest = req.body.version && req.body.request;
  
  if (isAlexaRequest) {
    // Handle direct Alexa request
    const requestType = req.body.request.type;
    
    // Handle LaunchRequest
    if (requestType === 'LaunchRequest') {
      return res.status(200).json({
        version: "1.0",
        response: {
          outputSpeech: {
            type: "PlainText",
            text: "Welcome to Health Data. How can I assist you with your health data today?"
          },
          reprompt: {
            outputSpeech: {
              type: "PlainText",
              text: "You can ask me about your steps, sleep, heart rate, or any health question.",
            },
          },
          shouldEndSession: false
        }
      });
    }
    
    // Handle IntentRequest
    if (requestType === "IntentRequest") {
      const intentName = req.body.request.intent.name;
      const requestUsername = String(req.body.username || "amy").toLowerCase();
      const clients = getClients();
      const clientSocket = clients.get(requestUsername);

      const slots = req.body.request.intent.slots;
      let question = "";
      const rawSlotValue = (slots && slots.question && slots.question.value) ? String(slots.question.value) : "";
      if (rawSlotValue) {
        question = rawSlotValue;
        if (intentName === "WhatIntent") question = `What ${question}`;
        else if (intentName === "HowIntent") question = `How ${question}`;
        else if (intentName === "WhoIntent") question = `Who ${question}`;
        else if (intentName === "WhereIntent") question = `Where ${question}`;
        else if (intentName === "WhenIntent") question = `When ${question}`;
        else if (intentName === "WhyIntent") question = `Why ${question}`;
        else if (intentName === "TellIntent") question = `Tell ${question}`;
      }

      const stageCommand = detectStageCommand(intentName, question, rawSlotValue);
      const sessionState = getQnaSessionState(requestUsername);

      if (stageCommand === "done") {
        clearQnaConversationState(requestUsername);
        gptChat.clearHistory();
        if (clientSocket) {
          clientSocket.send(JSON.stringify({ action: "qnaEnd", reason: "user_done" }));
          clientSocket.send(JSON.stringify({ action: "navigation", option: "/dashboard", data: {} }));
        }
        return res.status(200).json(makeAlexaResponse("Done. Returning to your dashboard.", { shouldEndSession: true }));
      }

      if (sessionState?.payload && (stageCommand === "next" || stageCommand === "previous" || stageCommand === "repeat")) {
        const stages = Array.isArray(sessionState.payload?.stages) ? sessionState.payload.stages : [];
        if (stages.length === 0) {
          return res.status(200).json(makeAlexaResponse("I do not have another chart yet. Ask a new health question.", {
            repromptText: "Ask me about steps, sleep, or heart rate.",
          }));
        }
        const currentIndex = Number.isFinite(sessionState.activeStageIndex) ? sessionState.activeStageIndex : 0;
        let targetIndex = currentIndex;
        if (stageCommand === "next") targetIndex += 1;
        if (stageCommand === "previous") targetIndex -= 1;
        targetIndex = Math.min(Math.max(targetIndex, 0), stages.length - 1);

        if ((stageCommand === "next" && currentIndex >= stages.length - 1) || (stageCommand === "previous" && currentIndex <= 0)) {
          const boundarySpeech = stageCommand === "next" ? "That was the last chart." : "You are already at the first chart.";
          return res.status(200).json(makeAlexaResponse(boundarySpeech, {
            repromptText: "Say repeat, next chart, previous chart, or done.",
          }));
        }

        const { stage, index } = getStageAtIndex(sessionState.payload, targetIndex);
        if (!stage) {
          return res.status(200).json(makeAlexaResponse("I do not have that chart yet."));
        }
        const nextPayload = {
          ...sessionState.payload,
          activeStageIndex: index,
        };
        setQnaSessionState(requestUsername, nextPayload, sessionState.userContext, sessionState.rawData);
        emitQnaStageSet(requestUsername, nextPayload, index, stage.cue || "", stage.speech || "");
        const stageSpeech = safeSpeech(stage.speech || stage.cue || "Here is your chart.");
        return res.status(200).json(makeAlexaResponse(stageSpeech, {
          repromptText: "Say next chart, previous chart, repeat, or done.",
        }));
      }

      if (!question) {
        return res.status(200).json(makeAlexaResponse("I did not catch that. Ask a health question, or say next chart, previous chart, repeat, or done.", {
          repromptText: "You can ask about steps, sleep, heart rate, or say next chart.",
        }));
      }

      console.log("Question extracted:", question);

      const existingDraft = pendingReminderDrafts.get(requestUsername) || null;
      if (existingDraft && isReminderCancelUtterance(question)) {
        pendingReminderDrafts.delete(requestUsername);
        return res.status(200).json(makeAlexaResponse("Okay, I won't set a reminder.", { shouldEndSession: false }));
      }

      const parsedReminder = parseReminderIntent(question, existingDraft);
      if (parsedReminder) {
        if (parsedReminder.missing?.length > 0) {
          const missingKey = parsedReminder.missing[0];
          const draftToStore = {
            ...parsedReminder,
            askedFor: missingKey,
          };
          pendingReminderDrafts.set(requestUsername, draftToStore);
          const prompt = missingKey === "title"
            ? "Sure. What should I remind you about?"
            : "Got it. What time should I set the reminder for?";
          const repromptText = missingKey === "title"
            ? "What should I remind you about?"
            : "What time do you want to be reminded?";
          return res.status(200).json({
            version: "1.0",
            response: {
              outputSpeech: {
                type: "PlainText",
                text: prompt,
              },
              reprompt: {
                outputSpeech: {
                  type: "PlainText",
                  text: repromptText,
                },
              },
              shouldEndSession: false,
            },
          });
        }

        try {
          pendingReminderDrafts.delete(requestUsername);
          const reminder = await createReminderFromAlexa(requestUsername, parsedReminder);
          const clients = getClients();
          const clientSocket = clients.get(requestUsername);
          if (clientSocket) {
            const confirmationText = `Reminder set: ${reminder.title}`;
            const scheduleText = `${parsedReminder.recurrenceText || "daily schedule"}`;
            const frontendPayload = normalizeFrontendPayload({
              question,
              summary: {
                shortSpeech: confirmationText,
                shortText: confirmationText,
              },
              stages: [{
                id: "reminder_stage_1",
                cue: "Your reminder is ready.",
                speech: safeSpeech(`Reminder set for ${reminder.title}.`),
                dataStatus: "ok",
                components: [{
                  component: "CustomList",
                  data: {
                    title: "Reminder schedule",
                    list: [
                    { label: "Reminder", value: reminder.title },
                    { label: "Recurrence", value: scheduleText },
                    { label: "Next alert", value: reminder.nextTriggerAt ? new Date(reminder.nextTriggerAt).toLocaleString() : "Soon" },
                    ],
                  },
                }],
              }],
            }, confirmationText);
            setQnaSessionState(requestUsername, frontendPayload, null, null);
            clientSocket.send(JSON.stringify({
              action: "navigation",
              option: "/qna",
              data: frontendPayload,
            }));
            emitQnaStageSet(requestUsername, frontendPayload, 0, frontendPayload.stages?.[0]?.cue || "", frontendPayload.stages?.[0]?.speech || "");
            clientSocket.send(JSON.stringify({
              action: "reminderSet",
              summaryText: confirmationText,
              scheduleText,
              reminderId: String(reminder._id),
            }));
          }

          return res.status(200).json({
            version: "1.0",
            response: {
              outputSpeech: {
                type: "PlainText",
                text: `Okay. I set a reminder to ${reminder.title}.`,
              },
              shouldEndSession: false,
            },
          });
        } catch (err) {
          console.error("Reminder creation from Alexa failed:", err.message);
          return res.status(200).json({
            version: "1.0",
            response: {
              outputSpeech: {
                type: "PlainText",
                text: "I could not set that reminder right now. Please try again.",
              },
              shouldEndSession: false,
            },
          });
        }
      }
      
      curUsername = requestUsername;
      state = "processing";
      
      // Fetch user profile for personalization
      try {
        const user = await User.findOne({ username: curUsername });
        
        const userContext = {
          age: user?.userProfile?.age || null,
          gender: user?.userProfile?.gender || 'unknown',
          fitnessLevel: user?.userProfile?.fitnessLevel || 'moderately_active',
          healthGoals: user?.userProfile?.healthGoals || [],
          healthConditions: user?.userProfile?.healthConditions || [],
          preferences: {
            preferredExercise: user?.userProfile?.preferences?.preferredExercise || [],
            sleepGoalMinutes: user?.userProfile?.preferences?.sleepGoalMinutes || 480,
            dailyStepGoal: user?.userProfile?.preferences?.dailyStepGoal || 10000,
            dailyCalorieGoal: user?.userProfile?.preferences?.dailyCalorieGoal || null,
          },
        };
        
        console.log("User context loaded:", JSON.stringify(userContext));
        
        // Check if this is a "Tell me more" follow-up
        const isTellMeMore = question.toLowerCase().includes("tell me more") || 
                             question.toLowerCase().includes("more details") ||
                             question.toLowerCase().includes("expand");
        
        try {
          const userInput = {
            type: isTellMeMore && lastTopic ? "rawData" : "question",
            data: isTellMeMore && lastTopic ? { topic: lastTopic, expand: true } : question,
            userContext: userContext,
            lastTopic: lastTopic,
          };

          const capturedUsername = curUsername;
          const capturedQuestion = question;
          const gptPromise = callGPT(userInput);
          const cutoffPromise = new Promise((resolve) => {
            setTimeout(() => resolve({ _cutoffResponse: true }), INTERNAL_CUTOFF_MS);
          });
          const hardDeadlinePromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error("Overall request timeout")), ALEXA_DEADLINE_MS);
          });

          let result;
          try {
            result = await Promise.race([gptPromise, cutoffPromise, hardDeadlinePromise]);
          } catch (err) {
            result = { type: "error", data: err.message || "timeout" };
          }

          const sendPayloadToFrontend = (payload) => {
            if (!clientSocket) return;
            clientSocket.send(JSON.stringify({ action: "navigation", option: "/qna", data: payload }));
            const firstStage = getStageAtIndex(payload, payload.activeStageIndex || 0);
            if (firstStage?.stage) {
              emitQnaStageSet(requestUsername, payload, firstStage.index, firstStage.stage.cue || "", firstStage.stage.speech || "");
            }
          };

          if (result && result._cutoffResponse === true) {
            const finalizedFallback = finalizeQnaPayload(null, capturedQuestion, userContext, null);
            setQnaSessionState(capturedUsername, finalizedFallback.payload, userContext, finalizedFallback.rawData);
            sendPayloadToFrontend(finalizedFallback.payload);

            gptPromise
              .then((bgResult) => {
                const finalized = finalizeQnaPayload(bgResult, capturedQuestion, userContext, bgResult?._rawData || null);
                setQnaSessionState(capturedUsername, finalized.payload, userContext, finalized.rawData);
                const socket = getClients().get(capturedUsername);
                if (socket) {
                  socket.send(JSON.stringify({ action: "navigation", option: "/qna", data: finalized.payload }));
                  const firstStage = getStageAtIndex(finalized.payload, finalized.payload.activeStageIndex || 0);
                  if (firstStage?.stage) {
                    emitQnaStageSet(capturedUsername, finalized.payload, firstStage.index, firstStage.stage.cue || "", firstStage.stage.speech || "");
                  }
                }
              })
              .catch((err) => console.error("Background GPT completion error:", err.message));

            return res.status(200).json(makeAlexaResponse(finalizedFallback.stageSpeech, {
              repromptText: "Say next chart, previous chart, repeat, or done.",
            }));
          }

          gptRet = result;
          state = "completed";
          const topic = result?.topic || null;
          if (topic) lastTopic = topic;

          if (result?.type === "close") {
            clearQnaConversationState(curUsername);
            gptChat.clearHistory();
            if (clientSocket) {
              clientSocket.send(JSON.stringify({ action: "navigation", option: "/dashboard", data: {} }));
            }
            return res.status(200).json(makeAlexaResponse(result.data || "Done.", { shouldEndSession: true }));
          }

          const finalized = finalizeQnaPayload(result, question, userContext, result?._rawData || null);
          setQnaSessionState(curUsername, finalized.payload, userContext, finalized.rawData);
          sendPayloadToFrontend(finalized.payload);
          return res.status(200).json(makeAlexaResponse(finalized.stageSpeech, {
            repromptText: "Say next chart, previous chart, repeat, or done.",
          }));
        } catch (err) {
          state = "error";
          console.error("GPT error:", err.message);
          const fallbackPayload = buildFailSafeQnaPayload(question, null, null);
        setQnaSessionState(requestUsername, fallbackPayload, null, null);
        if (clientSocket) {
          clientSocket.send(JSON.stringify({ action: "navigation", option: "/qna", data: fallbackPayload }));
          const firstStage = getStageAtIndex(fallbackPayload, 0);
          if (firstStage?.stage) {
            emitQnaStageSet(requestUsername, fallbackPayload, firstStage.index, firstStage.stage.cue || "", firstStage.stage.speech || "");
          }
        }
          return res.status(200).json(makeAlexaResponse("I had trouble loading that, but I put a safe summary chart on screen.", {
            repromptText: "Say next chart, previous chart, repeat, or ask another question.",
          }));
        }
      
      } catch (userFetchError) {
        console.error("Error fetching user profile:", userFetchError.message);
        return res.status(200).json(makeAlexaResponse("I could not access your profile right now. Please try again."));
      }
    }
    
    // Handle SessionEndedRequest
    if (requestType === 'SessionEndedRequest') {
      const sessionUsername = (req.body.username || req.body.session?.user?.username || "").toString().toLowerCase();
      if (sessionUsername) {
        pendingReminderDrafts.delete(sessionUsername);
      }
      return res.status(200).json({
        version: "1.0",
        response: {}
      });
    }
  } else {
    // Handle Lambda-formatted request (backward compatibility)
    let { userInput, username } = req.body;
    console.log("Lambda format - userInput:", JSON.stringify(userInput));
    console.log("Lambda format - username:", username);
    
    if (!username) {
      return res.status(400).json({ error: "Username is required" });
    }
    
    curUsername = username.toLowerCase();
    state = "processing";
    console.log("state -> processing");

    callGPT(userInput).then(result => {
      gptRet = result;
      state = "completed";
      console.log("state -> completed");
      console.log("current GptRet: " + JSON.stringify(gptRet));
    }).catch(err => {
      state = "error";
      console.error("GPT error:", err.message);
    });

    return res.status(200).json({ message: "received immediately" });
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
  } catch (err) {
    console.error("TTS endpoint error:", err.message);
    return res.status(500).json({ error: err.message || "TTS failed" });
  }
});

// Browser voice: same GPT+Fitbit pipeline, no 7s cap; response always pushed via WebSocket
alexaRouter.post("/browser-query", async (req, res) => {
  const username = String(req.body?.username || "amy").trim().toLowerCase();
  const question = String(req.body?.question || "").trim();
  if (!question) {
    return res.status(400).json({ ok: false, error: "question is required" });
  }
  res.status(200).json({ ok: true, message: "Processing..." });

  const clients = getClients();
  const clientSocket = clients.get(username);
  let userContext = null;

  try {
    const user = await User.findOne({ username });
    userContext = {
      age: user?.userProfile?.age || null,
      gender: user?.userProfile?.gender || "unknown",
      fitnessLevel: user?.userProfile?.fitnessLevel || "moderately_active",
      healthGoals: user?.userProfile?.healthGoals || [],
      healthConditions: user?.userProfile?.healthConditions || [],
      preferences: {
        preferredExercise: user?.userProfile?.preferences?.preferredExercise || [],
        sleepGoalMinutes: user?.userProfile?.preferences?.sleepGoalMinutes || 480,
        dailyStepGoal: user?.userProfile?.preferences?.dailyStepGoal || 10000,
        dailyCalorieGoal: user?.userProfile?.preferences?.dailyCalorieGoal || null,
      },
    };
  } catch (userErr) {
    console.error("browser-query: user fetch error", userErr.message);
  }

  const sendPayloadToFrontend = (payload) => {
    const socket = getClients().get(username);
    if (!socket) return;
    socket.send(JSON.stringify({ action: "navigation", option: "/qna", data: payload }));
    const firstStage = getStageAtIndex(payload, payload.activeStageIndex || 0);
    if (firstStage?.stage) {
      emitQnaStageSet(username, payload, firstStage.index, firstStage.stage.cue || "", firstStage.stage.speech || "");
    }
  };

  try {
    const userInput = { type: "question", data: question, userContext };
    const result = await callGPT(userInput);
    const finalized = finalizeQnaPayload(result, question, userContext, result?._rawData || null);
    setQnaSessionState(username, finalized.payload, userContext, finalized.rawData);
    sendPayloadToFrontend(finalized.payload);
  } catch (err) {
    console.error("browser-query error:", err.message);
    const finalized = finalizeQnaPayload(null, question, userContext, null);
    setQnaSessionState(username, finalized.payload, userContext, finalized.rawData);
    sendPayloadToFrontend(finalized.payload);
  }
});

alexaRouter.get("/back", (req, res) => {
  console.log("close");
    gptChat.clearHistory();
    lastTopic = null; // Clear topic on back
    clearQnaConversationState(curUsername);
    const clients = getClients();
    const clientSocket = clients.get(curUsername);
    if (curUsername && clients.has(curUsername) && clientSocket) {
      clientSocket.send(JSON.stringify({ action: "qnaEnd", reason: "user_done" }));
      const message = {
        action: "navigation",
        option: "/dashboard",
        data: {},
      };

      clientSocket.send(JSON.stringify(message));

      console.log(`Sent message to ${curUsername}:`, JSON.stringify(message));

    }
    gptRet = {};
    state = "completed";
  return res.status(200).json({ state: state });
});

alexaRouter.post("/end-qna", (req, res) => {
  const username = String(req.body?.username || curUsername || "amy").toLowerCase();
  clearQnaConversationState(username);
  gptChat.clearHistory();
  lastTopic = null;

  const clients = getClients();
  const clientSocket = clients.get(username);
  if (clientSocket) {
    clientSocket.send(JSON.stringify({ action: "qnaEnd", reason: "user_done" }));
    clientSocket.send(JSON.stringify({ action: "navigation", option: "/dashboard", data: {} }));
  }

  return res.status(200).json({ ok: true });
});

alexaRouter.post("/qna-stage", (req, res) => {
  const username = String(req.body?.username || "amy").toLowerCase();
  const direction = String(req.body?.direction || "").toLowerCase();
  const sessionState = getQnaSessionState(username);
  if (!sessionState?.payload) {
    return res.status(404).json({ ok: false, message: "No active QnA session." });
  }

  const stages = Array.isArray(sessionState.payload?.stages) ? sessionState.payload.stages : [];
  if (stages.length === 0) {
    return res.status(200).json({ ok: true, stageIndex: 0, speech: safeSpeech(sessionState.payload?.summary?.shortSpeech || "No chart available.") });
  }

  const currentIndex = Number.isFinite(sessionState.activeStageIndex) ? sessionState.activeStageIndex : 0;
  let nextIndex = currentIndex;
  if (direction === "next") nextIndex = Math.min(currentIndex + 1, stages.length - 1);
  if (direction === "previous") nextIndex = Math.max(currentIndex - 1, 0);
  if (Number.isFinite(Number(req.body?.stageIndex))) {
    nextIndex = Math.min(Math.max(Number(req.body.stageIndex), 0), stages.length - 1);
  }

  const nextPayload = { ...sessionState.payload, activeStageIndex: nextIndex };
  setQnaSessionState(username, nextPayload, sessionState.userContext, sessionState.rawData);
  const resolved = getStageAtIndex(nextPayload, nextIndex);
  if (resolved?.stage) {
    emitQnaStageSet(username, nextPayload, resolved.index, resolved.stage.cue || "", resolved.stage.speech || "");
  }

  return res.status(200).json({
    ok: true,
    stageIndex: resolved?.index ?? nextIndex,
    cue: resolved?.stage?.cue || "",
    speech: safeSpeech(resolved?.stage?.speech || resolved?.stage?.cue || nextPayload.summary?.shortSpeech || "Here is your chart."),
  });
});

function buildChartContextFromPayload(payload) {
  if (!payload || typeof payload !== "object") return "No chart context available.";
  const parts = [];
  if (payload.question) parts.push(`Question shown: ${payload.question}`);
  const summary = payload.summary?.shortText || payload.summary?.shortSpeech;
  if (summary) parts.push(`Summary: ${summary}`);
  const stages = Array.isArray(payload.stages) ? payload.stages : [];
  const comps = stages.flatMap((s) => (Array.isArray(s?.components) ? s.components : []));
  const deep = payload.deepAnalysis;
  const deepComps = Array.isArray(deep?.components) ? deep.components : [];
  const allComps = [...comps, ...deepComps];
  if (allComps.length > 0) {
    const first = allComps[0];
    const title = first?.data?.title || first?.explanationTitle || "Chart";
    const insight = first?.data?.insight || first?.explanationText || first?.chartSummary;
    if (title) parts.push(`Chart title: ${title}`);
    if (insight) parts.push(`Chart insight: ${insight}`);
  }
  return parts.length > 0 ? parts.join(". ") : "User was viewing a health data chart.";
}

async function callChartFollowUpGPT(chartContext, question) {
  const systemContent = `You are a health assistant. The user is viewing a health data screen. Given the following context and their question, respond with a short, helpful answer (under 100 words) and 2-3 suggested follow-up questions they could ask next. Return ONLY valid JSON with quoted keys: {"answer": "your answer text", "suggestedQuestions": ["question 1", "question 2"]}. No markdown or code fences.`;
  const userContent = `Context: ${chartContext}\n\nUser question: ${question}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemContent },
          { role: "user", content: userContent },
        ],
        temperature: 0.5,
        max_completion_tokens: 400,
      }),
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      const err = await response.text();
      console.error("Chart follow-up GPT error:", err);
      return { answer: "I couldn't process that right now. Try asking in a different way.", suggestedQuestions: [] };
    }
    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || "";
    const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const parsed = (() => {
      try {
        return JSON.parse(cleaned);
      } catch (e) {
        return null;
      }
    })();
    if (parsed && typeof parsed.answer === "string") {
      return {
        answer: parsed.answer,
        suggestedQuestions: Array.isArray(parsed.suggestedQuestions) ? parsed.suggestedQuestions.slice(0, 4) : [],
      };
    }
    return { answer: text || "I'm not sure how to answer that.", suggestedQuestions: [] };
  } catch (err) {
    clearTimeout(timeoutId);
    console.error("Chart follow-up GPT:", err.message);
    return { answer: "Something went wrong. Please try again.", suggestedQuestions: [] };
  }
}

alexaRouter.post("/qna-follow-up", (req, res) => {
  const username = String(req.body?.username || "amy").trim().toLowerCase();
  const question = String(req.body?.question || "").trim();
  if (!question) {
    return res.status(400).json({ error: "question is required", answer: "", suggestions: [] });
  }
  const pending = getQnaSessionState(username);
  const lastQnaPayload = pending?.lastQnaPayload || null;
  const chartContext = buildChartContextFromPayload(lastQnaPayload);
  callChartFollowUpGPT(chartContext, question)
    .then(({ answer, suggestedQuestions }) => {
      return res.status(200).json({ answer, suggestions: suggestedQuestions });
    })
    .catch((err) => {
      console.error("qna-follow-up error:", err);
      return res.status(500).json({
        answer: "Something went wrong. Please try again.",
        suggestions: [],
      });
    });
});

module.exports = alexaRouter;
