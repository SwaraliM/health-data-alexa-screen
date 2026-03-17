/**
 * backend/services/qna/continuationAgent.js
 *
 * Phase 7 continuation classifier.
 * This module normalizes follow-up intent into:
 * - bundle action (continue / branch / new)
 * - optional navigation action (replay/back/next/goto)
 * - whether generation is required vs replay is possible
 */

const CONTINUATION_DEBUG = process.env.QNA_CONTINUATION_DEBUG !== "false";

const NUMBER_WORD_MAP = {
  first: 1,
  one: 1,
  second: 2,
  two: 2,
  third: 3,
  three: 3,
  fourth: 4,
  four: 4,
  fifth: 5,
  five: 5,
  sixth: 6,
  six: 6,
  seventh: 7,
  seven: 7,
  eighth: 8,
  eight: 8,
  ninth: 9,
  nine: 9,
  tenth: 10,
  ten: 10,
};

function continuationLog(message, data = null) {
  if (!CONTINUATION_DEBUG) return;
  if (data == null) return console.log(`[ContinuationAgent] ${message}`);
  console.log(`[ContinuationAgent] ${message}`, data);
}

function normalizeText(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function hasReusableContext(activeBundleSummary = null) {
  if (!activeBundleSummary || typeof activeBundleSummary !== "object") return false;
  if (!activeBundleSummary.bundleId) return false;
  const stageCount = Number(activeBundleSummary.stageCount || 0);
  return stageCount > 0 || Boolean(activeBundleSummary.executorResponseId);
}

function extractBundleMetrics(activeBundleSummary = null) {
  const metrics = Array.isArray(activeBundleSummary?.metricsRequested)
    ? activeBundleSummary.metricsRequested
    : [];
  return metrics
    .map((metric) => String(metric || "").trim().toLowerCase())
    .filter(Boolean);
}

function isExplicitNewRequest(question = "") {
  const q = normalizeText(question);
  return /\b(start over|new analysis|new question|forget that|different topic|change topic|fresh start|brand new|reset|stop|done|that'?s enough|never mind|nevermind|all done|no more|finish|exit|quit|release)\b/.test(q);
}

function isExplicitBranchRequest(question = "") {
  const q = normalizeText(question);
  return /\b(instead|also|compare|versus|vs|another angle|dig into|branch|alternative view|does .* affect|what about)\b/.test(q);
}

function isExplicitContinueRequest(question = "") {
  const q = normalizeText(question);
  return /\b(continue|go on|tell me more|show more|next|deeper|what else|more detail|next chart|next stage|next insight|yes|yeah|sure|ok|okay)\b/.test(q)
    || /^(yes|yeah|sure|ok|okay)$/.test(q);
}

function isExplainOrMeaningRequest(question = "") {
  const q = normalizeText(question);
  return /\b(explain that|explain this|what does this mean|help me understand|why is that|what stands out|what am i looking at)\b/.test(q);
}

function isSummarizeRequest(question = "") {
  const q = normalizeText(question);
  return /\b(summarize this|summary of this|short summary|quick recap|give me a summary)\b/.test(q);
}

function referencesPriorContext(question = "") {
  const q = normalizeText(question);
  return /\b(that|this|same|it|previous|earlier|chart|analysis|insight)\b/.test(q);
}

function normalizeHumanStageNumber(stageNumber = null) {
  const numeric = Number(stageNumber);
  if (!Number.isFinite(numeric)) return null;
  if (numeric <= 0) return 0;
  return Math.max(0, Math.floor(numeric - 1));
}

function parseStageIndexFromQuestion(question = "") {
  const q = normalizeText(question);

  const directMatch = q.match(/\b(?:stage|step|panel)\s*(?:number\s*)?(\d{1,2})\b/);
  if (directMatch) {
    return normalizeHumanStageNumber(directMatch[1]);
  }

  const ordinalMatch = q.match(/\b(\d{1,2})(?:st|nd|rd|th)\s*(?:stage|step|panel)\b/);
  if (ordinalMatch) {
    return normalizeHumanStageNumber(ordinalMatch[1]);
  }

  const wordMatch = q.match(/\b(stage|step|panel)\s+(first|one|second|two|third|three|fourth|four|fifth|five|sixth|six|seventh|seven|eighth|eight|ninth|nine|tenth|ten)\b/);
  if (wordMatch) {
    return normalizeHumanStageNumber(NUMBER_WORD_MAP[wordMatch[2]] || null);
  }

  const reverseWordMatch = q.match(/\b(first|one|second|two|third|three|fourth|four|fifth|five|sixth|six|seventh|seven|eighth|eight|ninth|nine|tenth|ten)\s+(stage|step|panel)\b/);
  if (reverseWordMatch) {
    return normalizeHumanStageNumber(NUMBER_WORD_MAP[reverseWordMatch[1]] || null);
  }

  return null;
}

function detectNavigationAction(question = "") {
  const q = normalizeText(question);
  const stageIndex = parseStageIndexFromQuestion(q);

  if (/\b(start over|restart|reset)\b/.test(q)) {
    return { action: "start_over", stageIndex: null, reason: "explicit_start_over" };
  }

  if (/\b(go back|previous|prior|before that|last stage|back)\b/.test(q)) {
    return { action: "stage_back", stageIndex: null, reason: "explicit_back" };
  }

  if (/\b(replay|repeat|show that again|read that again|replay that)\b/.test(q)) {
    return { action: "stage_replay", stageIndex, reason: "explicit_replay" };
  }

  if (/\b(compare that|compare this|comparison|how does this compare)\b/.test(q)) {
    return { action: "compare", stageIndex: null, reason: "explicit_compare" };
  }

  if (/\b(explain that|explain this|what does this mean|why is that|what stands out|what am i looking at)\b/.test(q)) {
    return { action: "explain", stageIndex: null, reason: "explicit_explain" };
  }

  if (/\b(summarize this|summary of this|short summary|quick recap|give me a summary)\b/.test(q)) {
    return { action: "summarize", stageIndex: null, reason: "explicit_summarize" };
  }

  if (/\b(show more|tell me more|go on|continue|deeper|what else|next stage|next insight|next one|yes|yeah|sure|ok|okay)\b/.test(q) || /^(yes|yeah|sure|ok|okay)$/.test(q)) {
    return { action: "stage_next", stageIndex: null, reason: "explicit_next" };
  }

  if (stageIndex != null && /\b(show|go to|goto|open|jump)\b/.test(q)) {
    return { action: "stage_goto", stageIndex, reason: "explicit_stage_index" };
  }

  if (stageIndex != null && /\b(stage|step|panel)\b/.test(q)) {
    return { action: "stage_goto", stageIndex, reason: "implicit_stage_index" };
  }

  return { action: null, stageIndex: null, reason: null };
}

function mapPlannerModeToDecision(mode = "") {
  const normalizedMode = normalizeText(mode);
  if (normalizedMode === "continue_analysis") return "continue";
  if (normalizedMode === "branch_analysis") return "branch";
  if (normalizedMode === "new_analysis") return "new";
  return null;
}

function inferBundleActionFromQuestion(question = "", activeBundleSummary = null) {
  const q = normalizeText(question);
  const hasContext = hasReusableContext(activeBundleSummary);
  if (!hasContext) return null;

  if (/\b(what about .* now|what about .* instead)\b/.test(q)) {
    return { decision: "branch", reason: "what_about_branch_prompt" };
  }
  if (/\b(does .* affect that too|does .* affect this too)\b/.test(q)) {
    return { decision: "branch", reason: "affect_branch_prompt" };
  }
  if (/\b(compare that|compare this|how does that compare)\b/.test(q)) {
    return { decision: "branch", reason: "compare_branch_prompt" };
  }

  const metricTerms = ["sleep", "steps", "heart", "hrv", "stress", "recovery", "calories", "distance", "floors"];
  const requestedMetric = metricTerms.find((term) => q.includes(term));
  if (!requestedMetric) return null;

  const activeMetrics = extractBundleMetrics(activeBundleSummary);
  const metricAlreadyCovered = activeMetrics.some((metric) => metric.includes(requestedMetric));
  if (!metricAlreadyCovered && /\b(what about|how about|does)\b/.test(q)) {
    return { decision: "branch", reason: "metric_shift_branch_prompt" };
  }
  return null;
}

/**
 * Returns:
 * {
 *   decision: "continue" | "branch" | "new",
 *   reason: string,
 *   plannerMode: string,
 *   confidence: number,
 *   signals: object
 * }
 */
function classifyContinuation({ question, activeBundleSummary, plannerResult } = {}) {
  const hasActiveBundle = Boolean(activeBundleSummary?.bundleId);
  const hasContext = hasReusableContext(activeBundleSummary);
  const plannerMode = normalizeText(plannerResult?.mode || "");
  const plannerDecision = mapPlannerModeToDecision(plannerMode);

  const explicitNew = isExplicitNewRequest(question);
  const explicitBranch = isExplicitBranchRequest(question);
  const explicitContinue = isExplicitContinueRequest(question);
  const explicitExplain = isExplainOrMeaningRequest(question);
  const explicitSummarize = isSummarizeRequest(question);
  const contextReference = referencesPriorContext(question);

  if (!hasActiveBundle) {
    const result = {
      decision: "new",
      reason: "no_active_bundle",
      plannerMode,
      confidence: 0.99,
      signals: {
        explicitNew,
        explicitBranch,
        explicitContinue,
        explicitExplain,
        explicitSummarize,
        contextReference,
        hasContext,
      },
    };
    continuationLog("classified continuation", result);
    return result;
  }

  if (explicitNew) {
    const result = {
      decision: "new",
      reason: "explicit_new_request",
      plannerMode,
      confidence: 0.98,
      signals: {
        explicitNew,
        explicitBranch,
        explicitContinue,
        explicitExplain,
        explicitSummarize,
        contextReference,
        hasContext,
      },
    };
    continuationLog("classified continuation", result);
    return result;
  }

  const inferredBundleAction = inferBundleActionFromQuestion(question, activeBundleSummary);
  if (inferredBundleAction?.decision === "branch") {
    const result = {
      decision: "branch",
      reason: inferredBundleAction.reason || "inferred_branch_request",
      plannerMode,
      confidence: 0.88,
      signals: {
        explicitNew,
        explicitBranch,
        explicitContinue,
        explicitExplain,
        explicitSummarize,
        contextReference,
        hasContext,
      },
    };
    continuationLog("classified continuation", result);
    return result;
  }


  if (explicitBranch) {
    const result = {
      decision: "branch",
      reason: "explicit_branch_request",
      plannerMode,
      confidence: 0.95,
      signals: {
        explicitNew,
        explicitBranch,
        explicitContinue,
        explicitExplain,
        explicitSummarize,
        contextReference,
        hasContext,
      },
    };
    continuationLog("classified continuation", result);
    return result;
  }

  if (explicitContinue || explicitExplain || explicitSummarize) {
    const result = {
      decision: "continue",
      reason: explicitContinue ? "explicit_continue_request" : "explain_or_summarize_request",
      plannerMode,
      confidence: 0.96,
      signals: {
        explicitNew,
        explicitBranch,
        explicitContinue,
        explicitExplain,
        explicitSummarize,
        contextReference,
        hasContext,
      },
    };
    continuationLog("classified continuation", result);
    return result;
  }

  if (hasContext && contextReference) {
    const result = {
      decision: "continue",
      reason: "contextual_reference",
      plannerMode,
      confidence: 0.82,
      signals: {
        explicitNew,
        explicitBranch,
        explicitContinue,
        explicitExplain,
        explicitSummarize,
        contextReference,
        hasContext,
      },
    };
    continuationLog("classified continuation", result);
    return result;
  }

 // Safer: if planner says new and there's no strong context tie, trust it
const decision = plannerDecision === "new" ? "new"
: (hasContext && contextReference) ? "continue"
: plannerDecision || "new"; // default to new when signal is weak

  const result = {
    decision,
    reason: plannerDecision ? "planner_mode" : "safe_default_continue",
    plannerMode,
    confidence: plannerDecision ? 0.74 : 0.58,
    signals: {
      explicitNew,
      explicitBranch,
      explicitContinue,
      explicitExplain,
      explicitSummarize,
      contextReference,
      hasContext,
    },
  };
  continuationLog("classified continuation", result);
  return result;
}

function toBundleAction(decision = "continue") {
  const normalized = String(decision || "continue").toLowerCase();
  if (normalized === "new") return "new";
  if (normalized === "branch") return "branch";
  return "continue";
}

function analyzeFollowupIntent({ question, activeBundleSummary, plannerResult } = {}) {
  const normalizedQuestion = normalizeText(question);
  const continuation = classifyContinuation({
    question: normalizedQuestion,
    activeBundleSummary,
    plannerResult,
  });

  const navigation = detectNavigationAction(normalizedQuestion);
  if (navigation.action) {
    const action = navigation.action;
    const requiresGeneration = [
      "stage_next",
      "stage_goto",
      "compare",
      "start_over",
    ].includes(action);
    const canReplay = [
      "stage_back",
      "stage_replay",
      "explain",
      "summarize",
    ].includes(action);
    const decision = action === "start_over" ? "new" : "continue";
    const result = {
      ...continuation,
      decision,
      intentType: "control_navigation",
      bundleAction: decision === "new" ? "new" : "continue",
      action,
      targetStageIndex: navigation.stageIndex,
      reason: navigation.reason,
      requiresGeneration,
      canReplay,
      normalizedQuestion,
      confidence: 0.98,
    };
    continuationLog("follow-up intent routed to navigation", result);
    return result;
  }

  const bundleAction = toBundleAction(continuation.decision);
  const intentType = bundleAction === "new"
    ? "new_bundle"
    : bundleAction === "branch"
      ? "branch_bundle"
      : "continue_bundle";

  const result = {
    ...continuation,
    intentType,
    bundleAction,
    action: null,
    targetStageIndex: null,
    requiresGeneration: bundleAction !== "new",
    canReplay: bundleAction === "continue" && hasReusableContext(activeBundleSummary),
    normalizedQuestion,
  };
  continuationLog("follow-up intent classified", result);
  return result;
}

module.exports = {
  analyzeFollowupIntent,
  classifyContinuation,
  parseStageIndexFromQuestion,
};
