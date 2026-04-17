"use strict";

const POLL_UTTERANCES = new Set([
  "yes", "resume", "wait", "ok", "okay", "sure", "alright", "yeah", "yep",
  "go ahead", "continue", "keep going", "go on",
]);

const HEALTH_KEYWORD_PATTERN = /\b(sleep|heart|steps|calories|weight|activity|exercise|blood|pressure|rate|oxygen|spo2|walk|run|distance|floor|bmi|stress|breath|respiratory|resting|deep|rem|light|awake|health|fitbit|data|trend|average|goal|hrv|pulse|wellness|recovery)\b/i;
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
  if (/\b(go deeper|dig deeper|explain|what does (this|that) mean|tell me more|more detail)\b/.test(cleaned)) {
    return "go_deeper";
  }

  const action = normalizeControlAction(cleaned);
  if (["show_more", "back", "start_over", "go_deeper", "explain", "compare"].includes(action)) {
    return action;
  }
  return null;
}

function hasHealthSignal(text = "") {
  return HEALTH_KEYWORD_PATTERN.test(text);
}

function isExplicitHealthQuestion(text = "") {
  const cleaned = normalizeUtterance(text);
  if (!cleaned) return false;
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

function hasRemainingStages(interaction = null) {
  if (!interaction) return false;
  const currentIndex = Math.max(0, Number(interaction.currentStageIndex) || 0);
  const stageCount = Math.max(0, Number(interaction.stageCount) || 0);
  return stageCount > 0 && currentIndex < stageCount - 1;
}

function resolveAlexaTurn({
  utterance = "",
  isPolling = false,
  interaction = null,
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
  normalizeControlAction,
  normalizeUtterance,
  resolveAlexaTurn,
};
