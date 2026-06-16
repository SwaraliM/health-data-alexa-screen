"use strict";

const { classifyChartFollowup } = require("./chartQnaClassifier");

const POLL_UTTERANCES = new Set([
  "yes", "resume", "wait", "ok", "okay", "sure", "alright", "yeah", "yep",
  "go ahead", "continue", "keep going", "go on",
]);

// Include common verb forms (e.g. "slept" != "sleep") or long questions get mis-classified as ignore_chatter.
const HEALTH_KEYWORD_PATTERN = /\b(sleep|slept|sleeping|heart|steps|calories|weight|activity|exercise|blood|pressure|rate|oxygen|spo2|walk|walked|walking|run|ran|running|distance|floor|floors|bmi|stress|breath|respiratory|resting|deep|rem|light|awake|health|fitbit|data|trend|average|goal|hrv|pulse|wellness|recovery|compare|compared|comparison)\b/i;
const HEALTH_QUESTION_PREFIX_PATTERN = /^(what|how|when|why|where|which|who|tell|show|give|compare|analy[sz]e|summari[sz]e|explain|did|does|do|is|are|was|were|can|could|should|would|will)\b/i;
const HEALTH_QUESTION_CONTEXT_PATTERN = /\b(my|last|this|today|yesterday|week|month|trend|average|compare|chart|data|report|summary|insight|score)\b/i;
const SMALL_TALK_ACK_PATTERN = /^(thanks|thank you|okay thanks|ok thanks|sounds good|got it|i'm good|i am good|haha|ha ha|lol|nice|cool|great|alright thanks|appreciate it)$/i;
const CANCEL_PATTERN = /^(cancel|stop|never mind|nevermind|forget it|exit|quit|done)$/i;

function sanitizeText(value, max = 320, fallback = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : fallback;
}

function normalizeUtterance(value = "") {
  return sanitizeText(value, 320, "")
    .toLowerCase()
    .replace(/[!?.,]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+(null|undefined)$/, "");
}

function normalizeControlAction(rawAction = "") {
  const cleaned = normalizeUtterance(rawAction);
  if (!cleaned) return "";
  if ([
    "stage_next", "next", "next chart", "next please", "show more", "more",
    "continue", "go on", "yes", "okay", "ok", "sure", "resume",
  ].includes(cleaned)) {
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

function detectNavigationAction(text = "") {
  const cleaned = normalizeUtterance(text);
  if (!cleaned) return null;

  if (HEALTH_KEYWORD_PATTERN.test(cleaned)) return null;
  if (cleaned.split(" ").length > 8) return null;

  if (/\b(next)\b/.test(cleaned)) return "show_more";
  if (/\b(move on|keep going|go on|skip ahead|move forward|go forward)\b/.test(cleaned)) {
    return "show_more";
  }
  if (/^(show more|more please|continue|yes|yeah|yep|sure|ok|okay|alright|resume|go ahead|more|show me more)$/.test(cleaned)) {
    return "show_more";
  }
  if (/\b(previous|go back|step back|back up|before this|one before|prior)\b/.test(cleaned)) {
    return "back";
  }
  if (/^back$/.test(cleaned)) return "back";
  if (/\b(start over|restart|from the (start|beginning)|reset|first chart)\b/.test(cleaned)) {
    return "start_over";
  }
  // NOTE: "explain / what does this mean / tell me more / go deeper" are NOT navigation —
  // they are clarifications about the current chart, handled via looksLikeClarification →
  // chart_qna. Keeping them here would route them to a no-op navigation action.

  const action = normalizeControlAction(cleaned);
  if (["show_more", "back", "start_over", "compare"].includes(action)) {
    return action;
  }
  return null;
}

// Conversational clarification / "explain this" utterances about the current chart.
// These are NOT phrased as wh-questions, so looksLikeQuestion() misses them — but when a
// chart is on screen they should be answered as a chart follow-up (explain), not treated
// as navigation or a brand-new analysis.
const CLARIFICATION_PATTERN = /\b(do(es)?n'?t|did'?n?t|cannot|can'?t)\s+(understand|get|catch|follow)\b|\b(i'?m\s+)?confus(ed|ing)\b|\bwhat\s+(was|is|are|do(es)?|did)\s+(that|this|those|these|it|they|.*\bmean)\b|\bwhat\s+do(es)?\b.*\bmean\b|\bexplain\b|\bbreak\s+(it|that|this)\s+down\b|\bin\s+plain\b|\bsimpler\b|\bdumb(ed)?\s+it\s+down\b|\blost\s+me\b|\bno\s+idea\b|\b(not\s+clear|unclear)\b|^huh\b|\bcome\s+again\b|\bsay\s+(that|it)\s+again\b|\brepeat\b|\btell\s+me\s+more\b|\b(go|dig)\s+deeper\b|\bmore\s+detail\b|\bwhat\s+am\s+i\s+looking\s+at\b|\bdon'?t\s+follow\b/i;

function looksLikeClarification(text = "") {
  const cleaned = normalizeUtterance(text);
  if (!cleaned) return false;
  return CLARIFICATION_PATTERN.test(cleaned);
}

// Evaluative follow-ups about the current chart ("is that good or bad?", "is this normal
// for my age?", "should I be worried?"). They reference the visible chart deictically and
// ask for a judgement — answer in-context rather than ignoring or starting a new analysis.
const EVALUATIVE_FOLLOWUP_PATTERN = /\b(is|are|was|were)\s+(that|this|those|these|it|they|my)\b.*\b(normal|good|bad|healthy|ok|okay|fine|alright|concerning|worrying|worried|problem|high|low|enough|right|safe)\b|\bshould\s+i\s+(be\s+)?(worried|worry|concerned)\b|\b(is|are)\s+(that|this|those|these)\s+(a\s+)?(problem|concern|bad|good|normal|healthy|sign)\b|\bgood\s+or\s+bad\b|\bis\s+that\s+(too|enough)\b/i;

function looksLikeEvaluativeFollowup(text = "") {
  const cleaned = normalizeUtterance(text);
  if (!cleaned) return false;
  return EVALUATIVE_FOLLOWUP_PATTERN.test(cleaned);
}

// Generic wellness openers an older adult might say instead of naming a metric
// ("how am I doing?", "how have I been lately?", "check in on my health").
const GENERIC_WELLNESS_PATTERN = /\bhow\s+(am|have|are|is|'?s)\s+(i|i'?ve|my|things|everything|it)\b|\bhow\s+am\s+i\s+doing\b|\bhow\s+have\s+i\s+been\b|\bcheck\s+(in|up)\b|\bhow'?s\s+my\s+health\b|\bam\s+i\s+(doing\s+)?(ok|okay|alright|well|healthy)\b|\bhow\s+do\s+i\s+look\b/i;

function looksLikeGenericWellness(text = "") {
  const cleaned = normalizeUtterance(text);
  if (!cleaned) return false;
  return GENERIC_WELLNESS_PATTERN.test(cleaned);
}

function hasHealthSignal(text = "") {
  return HEALTH_KEYWORD_PATTERN.test(text);
}

function isExplicitHealthQuestion(text = "") {
  const cleaned = normalizeUtterance(text);
  if (!cleaned) return false;
  // Generic wellness openers ("how am I doing") have no metric keyword but ARE health questions.
  if (looksLikeGenericWellness(cleaned)) return true;
  if (!hasHealthSignal(cleaned)) return false;
  if (HEALTH_QUESTION_PREFIX_PATTERN.test(cleaned)) return true;
  if (HEALTH_QUESTION_CONTEXT_PATTERN.test(cleaned) && cleaned.split(" ").length >= 3) return true;
  return cleaned.split(" ").length >= 5;
}

function isSmallTalkAck(text = "") {
  const cleaned = normalizeUtterance(text);
  if (!cleaned) return false;
  if (SMALL_TALK_ACK_PATTERN.test(cleaned)) return true;
  if (/^(okay|ok|sure|alright|right|got it)$/.test(cleaned)) return true;
  return false;
}

const CHART_VISIBLE_MODES = new Set(["ready_to_deliver", "awaiting_continue", "complete"]);
const QUESTION_PREFIX_PATTERN = /^(what|why|which|how|when|tell|show|explain|is|are|did|does|do)\b/i;

function looksLikeQuestion(text = "") {
  const cleaned = normalizeUtterance(text);
  if (!cleaned) return false;
  if (cleaned.split(" ").length < 3) return false;
  if (/\?/.test(String(text || ""))) return true;
  return QUESTION_PREFIX_PATTERN.test(cleaned);
}

function hasRemainingStages(interaction = null) {
  if (!interaction) return false;
  const currentIndex = Math.max(0, Number(interaction.currentStageIndex) || 0);
  const stageCount = Math.max(0, Number(interaction.stageCount) || 0);
  return stageCount > 0 && currentIndex < stageCount - 1;
}

async function resolveAlexaTurn({
  utterance = "",
  isPolling = false,
  interaction = null,
  chartContext = null,
} = {}) {
  const resolvedUtterance = sanitizeText(utterance, 320, "");
  const normalizedUtterance = normalizeUtterance(resolvedUtterance);
  const hasActiveInteraction = Boolean(interaction && interaction.mode && interaction.mode !== "idle");
  const navigationAction = detectNavigationAction(normalizedUtterance);
  const pollingShortcut = isPolling && (
    !normalizedUtterance ||
    normalizedUtterance === "trying again" ||
    normalizedUtterance.length < 3 ||
    POLL_UTTERANCES.has(normalizedUtterance)
  );

  if (navigationAction === "start_over") {
    return {
      kind: "navigation",
      action: navigationAction,
      interruptsActiveInteraction: false,
      resolvedUtterance,
    };
  }

  if (CANCEL_PATTERN.test(normalizedUtterance)) {
    return {
      kind: "cancel_reset",
      action: "cancel",
      interruptsActiveInteraction: true,
      resolvedUtterance,
    };
  }

  if (!hasActiveInteraction) {
    if (navigationAction) {
      return {
        kind: "navigation",
        action: navigationAction,
        interruptsActiveInteraction: false,
        resolvedUtterance,
      };
    }
    if (isExplicitHealthQuestion(normalizedUtterance)) {
      return {
        kind: "new_health_question",
        action: "ask",
        interruptsActiveInteraction: false,
        resolvedUtterance,
      };
    }
    return {
      kind: "no_active_context_fallback",
      action: "",
      interruptsActiveInteraction: false,
      resolvedUtterance,
    };
  }

  const mode = String(interaction.mode || "idle");
  const remainingStages = hasRemainingStages(interaction);

  if (pollingShortcut) {
    if ((mode === "awaiting_continue" || mode === "complete") && remainingStages) {
      return {
        kind: "navigation",
        action: "show_more",
        interruptsActiveInteraction: false,
        resolvedUtterance,
      };
    }
    return {
      kind: "resume_pending",
      action: "resume_pending",
      interruptsActiveInteraction: false,
      resolvedUtterance,
    };
  }

  // Clarification / "explain this" while a chart is visible → answer about the
  // current chart. Short-circuit WITHOUT the LLM classifier so it is robust even
  // if the classifier errors or times out. Runs before isExplicitHealthQuestion so
  // "I didn't understand the exercise metrics" explains instead of starting anew.
  if (
    hasActiveInteraction &&
    CHART_VISIBLE_MODES.has(mode) &&
    chartContext &&
    (looksLikeClarification(normalizedUtterance) || looksLikeEvaluativeFollowup(normalizedUtterance))
  ) {
    return {
      kind: "chart_qna",
      action: looksLikeEvaluativeFollowup(normalizedUtterance) ? "evaluate" : "explain",
      interruptsActiveInteraction: false,
      resolvedUtterance,
      supplementalMetrics: [],
    };
  }

  // Chart follow-up detection: when a chart is visible and the utterance
  // looks like a question, ask the LLM classifier before deciding whether
  // to start a new pipeline or answer in-context.
  if (
    hasActiveInteraction &&
    CHART_VISIBLE_MODES.has(mode) &&
    chartContext &&
    looksLikeQuestion(normalizedUtterance) &&
    !SMALL_TALK_ACK_PATTERN.test(normalizedUtterance)
  ) {
    try {
      const classification = await classifyChartFollowup(normalizedUtterance, {
        ...chartContext,
        original_question: interaction.originalQuestion || "",
      });
      if (classification.turn_type === "chart_qna" || classification.turn_type === "chart_qna_with_fetch") {
        return {
          kind: "chart_qna",
          action: "chart_qna",
          interruptsActiveInteraction: false,
          resolvedUtterance,
          supplementalMetrics: Array.isArray(classification.supplemental_metrics)
            ? classification.supplemental_metrics
            : [],
        };
      }
    } catch (_) {
      // Classifier failed — fall through to existing logic
    }
  }

  if (isExplicitHealthQuestion(normalizedUtterance)) {
    return {
      kind: "new_health_question",
      action: "ask",
      interruptsActiveInteraction: true,
      resolvedUtterance,
    };
  }

  if (navigationAction) {
    if ((mode === "generating" || mode === "ready_to_deliver") && navigationAction === "show_more") {
      return {
        kind: "resume_pending",
        action: "resume_pending",
        interruptsActiveInteraction: false,
        resolvedUtterance,
      };
    }
    if (remainingStages || navigationAction !== "show_more") {
      return {
        kind: "navigation",
        action: navigationAction,
        interruptsActiveInteraction: false,
        resolvedUtterance,
      };
    }
  }

  if (isSmallTalkAck(normalizedUtterance)) {
    return {
      kind: "small_talk_ack",
      action: mode === "awaiting_continue" && remainingStages ? "show_more" : "resume_pending",
      interruptsActiveInteraction: false,
      resolvedUtterance,
    };
  }

  if (normalizedUtterance && !hasHealthSignal(normalizedUtterance)) {
    return {
      kind: "ignore_chatter",
      action: mode === "awaiting_continue" && remainingStages ? "show_more" : "resume_pending",
      interruptsActiveInteraction: false,
      resolvedUtterance,
    };
  }

  return {
    kind: "resume_pending",
    action: "resume_pending",
    interruptsActiveInteraction: false,
    resolvedUtterance,
  };
}

module.exports = {
  POLL_UTTERANCES,
  detectNavigationAction,
  hasHealthSignal,
  isExplicitHealthQuestion,
  looksLikeQuestion,
  looksLikeClarification,
  looksLikeEvaluativeFollowup,
  looksLikeGenericWellness,
  normalizeControlAction,
  normalizeUtterance,
  resolveAlexaTurn,
};
