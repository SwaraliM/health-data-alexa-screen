/**
 * backend/services/qna/stageService.js
 *
 * Stage normalization and payload building.
 * Simplified — no staging/progression concept. Charts are pre-generated
 * and indexed into by the orchestrator.
 */

"use strict";

const {
  buildFallbackChartSpec,
  validateChartSpec,
} = require("../chartSpecService");
const { hydrateChartSpec } = require("../charts/chartPresetHydrator");

function sanitizeText(value, max = 420, fallback = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : fallback;
}

function sanitizeTextNoTruncate(value, fallback = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text ? text : fallback;
}

function uniqueList(values = [], max = 6) {
  const list = [];
  (Array.isArray(values) ? values : []).forEach((value) => {
    const normalized = sanitizeText(value, 120, "");
    if (!normalized) return;
    if (!list.includes(normalized)) list.push(normalized);
  });
  return list.slice(0, max);
}

function ensureSentence(text = "") {
  const safe = sanitizeTextNoTruncate(text, "");
  if (!safe) return "";
  if (/[.!?]$/.test(safe)) return safe;
  return `${safe}.`;
}

function getChartVisualSentence(chartSpec = null) {
  const chartType = String(chartSpec?.chart_type || "").toLowerCase();
  if (chartType.includes("donut")) return "The donut chart shows your key reading at the center, with the breakdown displayed in the ring around it.";
  if (chartType.includes("bar")) return "The bars show how the values change across the time labels.";
  if (chartType.includes("line")) return "The line shows how the values move over time.";
  if (chartType.includes("scatter")) return "The points compare two measures and show how they move together.";
  if (chartType.includes("pie")) return "The slices show how each part contributes to the whole.";
  if (chartType.includes("gauge")) return "The gauge shows where your current value sits in the range.";
  if (chartType.includes("heatmap")) return "The color blocks show where values are higher or lower across days and metrics.";
  if (chartType.includes("radar")) return "The shape on the radar chart shows how your metrics compare to each other at a glance.";
  if (chartType.includes("timeline")) return "The timeline shows how your data changes step by step over time.";
  return "The chart shows your trend clearly in one view.";
}

function ensureNarratedScreenText({ screenText = "", spokenText = "", chartSpec = null } = {}) {
  const candidate = sanitizeTextNoTruncate(
    screenText || chartSpec?.takeaway || spokenText,
    "This chart highlights your latest health trend."
  );
  return ensureSentence(candidate);
}

function hasInterpretiveContent(text = "") {
  return /\b(means|suggests|tells us|shows that|which means|this matters|overall|in short|so to answer|improv|declin|rising|falling|better|worse|steady|normal|concern|healthy|restful|recovered|pattern)\b/i.test(text);
}

function ensureNarratedSpokenText({ spokenText = "", screenText = "", chartSpec = null, title = "Health insight" } = {}) {
  let narrated = sanitizeTextNoTruncate(spokenText, "");

  const orientationSentence = ensureSentence(`Here is what you see on the screen: ${title}.`);
  const visualSentence = ensureSentence(getChartVisualSentence(chartSpec));
  const meaningSeed = sanitizeTextNoTruncate(
    screenText || chartSpec?.takeaway || "this trend gives a clear direction for your next step",
    "this trend gives a clear direction for your next step"
  );
  const overallSentence = ensureSentence(`Overall, ${meaningSeed}`);

  // If the executor provided substantive spoken text, preserve it but still add
  // interpretive meaning when it only describes the visual.
  if (narrated && narrated.length >= 40) {
    if (!hasInterpretiveContent(narrated)) {
      narrated = `${narrated} ${overallSentence}`;
    }
    return narrated;
  }

  if (!narrated) {
    return `${orientationSentence} ${visualSentence} ${overallSentence}`;
  }

  // Short/incomplete spoken text — enrich with fallback sentences
  if (!/\b(on the screen|you see|this chart)\b/i.test(narrated)) {
    narrated = `${orientationSentence} ${narrated}`;
  }
  if (!/\b(the bars|the line|the points|the slices|the chart|timeline|gauge|color)\b/i.test(narrated)) {
    narrated = `${narrated} ${visualSentence}`;
  }
  if (!/\b(what stands out|this means|overall|in short)\b/i.test(narrated)) {
    narrated = `${narrated} ${ensureSentence(`What stands out is ${meaningSeed}`)}`;
  }

  return narrated;
}

function normalizeFollowupPhrase(value = "") {
  const raw = sanitizeText(value, 120, "").toLowerCase();
  if (!raw) return "";
  if (/^(next|show more|more|tell me more|go on|continue|yes|yeah|sure|ok|okay)$/.test(raw)) return "show more";
  if (/^(go back|back|previous)$/.test(raw)) return "go back";
  if (/^(explain|explain that|explain this)$/.test(raw)) return "explain that";
  if (/^(compare|compare that|compare this)$/.test(raw)) return "compare that";
  if (/^(what does this mean|what does that mean)$/.test(raw)) return "what does this mean";
  if (/^(start over|restart|reset)$/.test(raw)) return "start over";
  return raw;
}

/**
 * Estimate how long Alexa will take to speak the given text.
 * Alexa speaks English at ~150 wpm (2.5 words/sec).
 * 10% padding absorbs prosody/pause variance.
 */
function estimateSpeechDurationMs(text) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean).length;
  if (words === 0) return 0;
  const ALEXA_WPS = 2.5;
  const PADDING = 1.1;
  return Math.ceil((words / ALEXA_WPS) * PADDING * 1000);
}

// Silence between stages — gives the user time to look at the chart
// and absorbs any timing drift between Alexa speech and frontend chart display.
const STAGE_BREAK_MS = 5000;

/**
 * Combine all stages' spoken text into one flowing narrative for auto-advance.
 * Alexa speaks this as a single response; the frontend auto-cycles charts.
 *
 * Returns { voiceText, chartAdvanceSchedule } where:
 *   - voiceText: SSML string with <break> tags between stages
 *   - chartAdvanceSchedule: array of { stageIndex, offsetMs } for frontend chart timing
 *
 * Each chart gets:
 *   1. A position + transition sentence ("Let's start with your first chart...")
 *   2. The full executor-generated spoken text (already 2-3 sentences from ensureNarratedSpokenText)
 *   3. A brief visual anchor sentence tying the spoken narrative to what's on screen
 */
function buildCombinedVoiceAnswer(stages = []) {
  const sorted = (Array.isArray(stages) ? stages : [])
    .slice()
    .sort((a, b) => Number(a?.stageIndex || 0) - Number(b?.stageIndex || 0));
  if (!sorted.length) return { voiceText: "", chartAdvanceSchedule: [] };

  const total = sorted.length;

  // Each chart gets a contextual intro and a visual anchor, wrapping the full spoken text
  const INTROS = [
    (title, total) => `Let's start with your first chart. This one is about ${title}.`,
    (title, total) => `Now, here is your second chart. This looks at ${title}.`,
    (title, total) => `And for the last part of the analysis, this chart covers ${title}.`,
    (title, total) => `Next up, chart ${4} of ${total}. This explores ${title}.`,
    (title, total) => `Moving on to chart ${5} of ${total}, which focuses on ${title}.`,
    (title, total) => `And one more: chart ${6} of ${total}, looking at ${title}.`,
  ];

  const BRIDGES = [
    "Take a look at the screen to see the full picture.",
    "You can see the details on the screen right now.",
    "The chart on the screen shows this clearly.",
  ];

  const chartAdvanceSchedule = [];
  let cumulativeMs = 0;

  const parts = sorted.map((stage, idx) => {
    const spoken = sanitizeTextNoTruncate(stage?.spokenText, "");
    if (!spoken) return "";

    const title = sanitizeText(stage?.title, 80, "your health data").toLowerCase();
    const introFn = idx < INTROS.length ? INTROS[idx] : INTROS[INTROS.length - 1];
    const intro = introFn(title, total);
    const bridge = BRIDGES[idx % BRIDGES.length];

    const stageText = `${intro} ${spoken} ${bridge}`;

    // Record when this chart should appear on screen
    // narration_text added to each schedule entry so the frontend can display the matching
    // narration text on screen when each chart advance timer fires, keeping voice and screen in sync.
    chartAdvanceSchedule.push({ stageIndex: idx, offsetMs: cumulativeMs, narration_text: stage?.spokenText || "" });

    // Accumulate: this stage's speech duration + break before next stage
    const speechMs = estimateSpeechDurationMs(stageText);
    cumulativeMs += speechMs + (idx < sorted.length - 1 ? STAGE_BREAK_MS : 0);

    // Insert SSML break between stages (not after the last one)
    if (idx < sorted.length - 1) {
      return `${stageText} <break time="${Math.round(STAGE_BREAK_MS / 1000)}s"/>`;
    }
    return stageText;
  }).filter(Boolean);

  if (!parts.length) return { voiceText: "", chartAdvanceSchedule: [] };

  const voiceText = parts.join(" ") + " That covers everything I found. Feel free to ask me another question anytime.";
  return { voiceText, chartAdvanceSchedule };
}

function buildVoiceFirstFollowups(values = [], moreAvailable = false) {
  const normalized = uniqueList(
    (Array.isArray(values) ? values : []).map(normalizeFollowupPhrase).filter(Boolean),
    6
  );
  const merged = [];
  if (moreAvailable) {
    merged.push("show more");
  }
  merged.push("go back", "explain that");
  merged.push(...normalized);
  if (!moreAvailable) merged.push("start over");
  return uniqueList(merged, 6);
}

function createStageRecord({
  stageIndex = 0,
  title = "Health insight",
  spokenText = "",
  screenText = "",
  chartSpec = null,
  suggestedFollowups = [],
  moreAvailable = false,
  source = "executor_agent",
  requestId = null,
  question = "",
  metadata = null,
} = {}) {
  const now = new Date().toISOString();
  return {
    stageIndex: Math.max(0, Number(stageIndex) || 0),
    title: sanitizeText(title, 120, "Health insight"),
    spokenText: sanitizeTextNoTruncate(spokenText, ""),
    screenText: sanitizeTextNoTruncate(screenText, ""),
    chartSpec: chartSpec || null,
    suggestedFollowups: buildVoiceFirstFollowups(suggestedFollowups, moreAvailable),
    moreAvailable: Boolean(moreAvailable),
    source: sanitizeText(source, 40, "executor_agent"),
    requestId: requestId ? String(requestId) : null,
    question: sanitizeText(question, 280, ""),
    createdAt: now,
    updatedAt: now,
    metadata: metadata && typeof metadata === "object" ? metadata : {},
  };
}

function normalizeChartSpec(chartSpec, title = "Health insight", spokenText = "", screenText = "") {
  if (!chartSpec || typeof chartSpec !== "object") {
    return buildFallbackChartSpec(
      sanitizeText(title, 80, "Health insight"),
      sanitizeText(screenText || spokenText, 180, "Here is your health insight.")
    );
  }

  // chart_data present → hydrate from preset library
  if (chartSpec.chart_data && typeof chartSpec.chart_data === "object") {
    return hydrateChartSpec(chartSpec, sanitizeText(title, 80, "Health insight"));
  }

  // Legacy: option already an object
  if (chartSpec.option && typeof chartSpec.option === "object") {
    return validateChartSpec(chartSpec, sanitizeText(title, 80, "Health insight"));
  }

  return buildFallbackChartSpec(
    sanitizeText(title, 80, "Health insight"),
    sanitizeText(chartSpec.takeaway || screenText || spokenText, 180, "Here is your health insight.")
  );
}

function resolveStageMetrics(stage = null, bundle = null) {
  if (Array.isArray(stage?.metadata?.stageMetrics) && stage.metadata.stageMetrics.length) {
    return stage.metadata.stageMetrics.slice(0, 8);
  }
  if (Array.isArray(stage?.metadata?.metrics) && stage.metadata.metrics.length) {
    return stage.metadata.metrics.slice(0, 8);
  }
  return Array.isArray(bundle?.metricsRequested) ? bundle.metricsRequested.slice(0, 8) : ["steps"];
}

/**
 * Normalize executor GPT output into a stage record.
 */
function normalizeExecutorStageOutput({
  executorOutput = null,
  stageIndex = 0,
  requestId = null,
  question = "",
  source = "executor_agent",
  fallbackTitle = "Health insight",
} = {}) {
  const raw = executorOutput && typeof executorOutput === "object" ? executorOutput : {};
  const title = sanitizeText(raw.title, 120, fallbackTitle);
  const chartSpec = normalizeChartSpec(
    raw.chart_spec || raw.chartSpec,
    title,
    raw.spoken_text || raw.spokenText,
    raw.screen_text || raw.screenText
  );
  const screenText = ensureNarratedScreenText({
    screenText: raw.screen_text || raw.screenText,
    spokenText: raw.spoken_text || raw.spokenText,
    chartSpec,
  });
  const spokenText = ensureNarratedSpokenText({
    spokenText: raw.spoken_text || raw.spokenText,
    screenText,
    chartSpec,
    title,
  });
  const rawMoreAvailable = raw.more_available ?? raw.moreAvailable;
  const moreAvailable = rawMoreAvailable == null ? false : Boolean(rawMoreAvailable);
  const suggestedFollowups = buildVoiceFirstFollowups(
    Array.isArray(raw.suggested_followups) ? raw.suggested_followups : raw.suggestedFollowups,
    moreAvailable
  );

  return createStageRecord({
    stageIndex,
    title,
    spokenText,
    screenText,
    chartSpec,
    suggestedFollowups,
    moreAvailable,
    source,
    requestId,
    question,
    metadata: {
      voiceFirst: true,
      narratedVisualUnit: true,
      executor: {
        continuationHint: sanitizeText(raw.continuation_hint || raw.continuationHint, 220, ""),
        analysisNotes: sanitizeText(raw.analysis_notes || raw.analysisNotes, 320, ""),
      },
    },
  });
}

function getStageByIndex(bundle = null, stageIndex = null) {
  if (!bundle || typeof bundle !== "object") return null;
  const stages = Array.isArray(bundle.stages) ? bundle.stages : [];
  if (!stages.length) return null;
  const normalizedStageIndex = Math.max(0, Number(stageIndex) || 0);
  return stages.find((stage) => Number(stage?.stageIndex) === normalizedStageIndex) || null;
}

function getCurrentStage(bundle = null) {
  if (!bundle || typeof bundle !== "object") return null;
  const stages = Array.isArray(bundle.stages) ? bundle.stages : [];
  if (!stages.length) return null;
  const currentIndex = Number.isFinite(Number(bundle.currentStageIndex))
    ? Math.max(0, Number(bundle.currentStageIndex))
    : stages.length - 1;
  return stages.find((stage) => Number(stage?.stageIndex) === currentIndex)
    || stages[stages.length - 1]
    || null;
}

function getLatestStage(bundle = null) {
  if (!bundle || typeof bundle !== "object") return null;
  const stages = Array.isArray(bundle.stages) ? bundle.stages : [];
  if (!stages.length) return null;
  return stages
    .slice()
    .sort((a, b) => Number(a?.stageIndex || 0) - Number(b?.stageIndex || 0))
    .slice(-1)[0] || null;
}

/**
 * Build the full payload for a stage — used for both voice and frontend/WebSocket.
 */
function buildStagePayload({
  bundle = null,
  stageRecord = null,
  question = "",
  requestId = null,
  voiceAnswerSource = "gpt",
  stageCountOverride = null,
} = {}) {
  const stage = stageRecord && typeof stageRecord === "object" ? stageRecord : null;
  const safeStage = stage || createStageRecord({
    stageIndex: 0,
    title: "Health insight",
    spokenText: "",
    screenText: "",
    chartSpec: buildFallbackChartSpec("Health insight", "I could not prepare that insight."),
    suggestedFollowups: [],
    moreAvailable: false,
    source: "stage_payload_fallback",
    requestId,
    question,
  });

  const stages = Array.isArray(bundle?.stages)
    ? bundle.stages.slice().sort((a, b) => Number(a?.stageIndex || 0) - Number(b?.stageIndex || 0))
    : [safeStage];
  const normalizedCurrentIndex = Math.max(0, Number(safeStage.stageIndex || 0));
  const suggestedFollowups = buildVoiceFirstFollowups(
    safeStage.suggestedFollowups || [],
    safeStage.moreAvailable
  ).slice(0, 4);

  const nextViews = suggestedFollowups.map((label, idx) => ({
    id: `stage_${normalizedCurrentIndex}_next_${idx + 1}`,
    label,
    goal: "deep_dive",
    metrics: resolveStageMetrics(safeStage, bundle),
    visual_family: safeStage?.chartSpec?.chart_type || "list_summary",
  }));

  const chartSpecForPanel = (safeStage.chartSpec && typeof safeStage.chartSpec === "object")
    ? normalizeChartSpec(safeStage.chartSpec, safeStage.title || "Health insight", safeStage.spokenText || "", safeStage.screenText || "")
    : buildFallbackChartSpec(safeStage.title || "Health insight", safeStage.screenText || safeStage.spokenText || "No chart.");

  const panel = {
    panel_id: `stage_${normalizedCurrentIndex}`,
    title: safeStage.title,
    subtitle: "",
    goal: "deep_dive",
    metrics: resolveStageMetrics(safeStage, bundle),
    visual_family: chartSpecForPanel?.chart_type || "list_summary",
    chart_spec: chartSpecForPanel,
  };

  const bundleComplete = safeStage.moreAvailable === false;

  // Position context for voice — prefer the caller-supplied count (actual generated stages)
  const stageCount = stageCountOverride != null
    ? Math.max(1, Number(stageCountOverride))
    : (() => {
        const planned = Array.isArray(bundle?.stagesPlan) && bundle.stagesPlan.length
          ? bundle.stagesPlan.length
          : Array.isArray(bundle?.stages) ? bundle.stages.length : 1;
        return Math.max(1, planned);
      })();

  // Auto-advance: if all stages are available, combine into one flowing narrative
  const allStagesAvailable = stages.length >= stageCount && stageCount > 1;
  const autoAdvance = allStagesAvailable && normalizedCurrentIndex === 0;

  let fullVoiceAnswer;
  let chartAdvanceSchedule = [];
  if (autoAdvance) {
    const combined = buildCombinedVoiceAnswer(stages);
    fullVoiceAnswer = combined.voiceText;
    chartAdvanceSchedule = combined.chartAdvanceSchedule;
  } else {
    const completionOffer = bundleComplete
      ? " That covers everything I found. Feel free to ask me another question anytime."
      : "";
    fullVoiceAnswer = safeStage.spokenText + completionOffer;
  }

  return {
    status: "ready",
    requestId: requestId || safeStage.requestId || null,
    interaction_mode: "voice_first",
    navigation_mode: "voice_only",
    voice_navigation_only: true,
    autoAdvance,
    autoAdvanceIntervalMs: autoAdvance ? 15000 : 0,
    chartAdvanceSchedule: autoAdvance ? chartAdvanceSchedule : [],
    question: sanitizeText(question || safeStage.question, 280, ""),
    spoken_answer: fullVoiceAnswer,
    voice_answer: fullVoiceAnswer,
    bundle_complete: bundleComplete,
    voice_answer_source: sanitizeText(voiceAnswerSource, 20, "gpt"),
    answer_ready: true,
    payload_ready: true,
    report_title: safeStage.title,
    takeaway: safeStage.screenText || safeStage.spokenText,
    primary_answer: safeStage.screenText || safeStage.spokenText,
    primary_visual: chartSpecForPanel,
    chart_spec: chartSpecForPanel,
    summary: {
      shortSpeech: safeStage.spokenText,
      shortText: safeStage.screenText || safeStage.spokenText,
    },
    panels: [panel],
    next_views: nextViews,
    suggestedDrillDowns: suggestedFollowups.slice(0, 3),
    suggested_follow_up: suggestedFollowups.slice(0, 3),
    voice_navigation_hints: suggestedFollowups.map((phrase) => `Say: ${phrase}`),
    suggested_followup_prompt: nextViews[0]
      ? `Say "${String(nextViews[0].label || "").toLowerCase()}" for more.`
      : "",
    followup_mode: "suggested_drill_down",
    stages: stages.map((item, idx) => ({
      id: `stage_${Number(item?.stageIndex || idx)}`,
      speech: sanitizeTextNoTruncate(item?.spokenText, ""),
      voice_answer: sanitizeTextNoTruncate(item?.spokenText, ""),
      screen_text: sanitizeText(item?.screenText, 320, ""),
      chart_spec: item?.chartSpec || null,
      summary: sanitizeText(item?.screenText, 240, ""),
      title: sanitizeText(item?.title, 120, "Health insight"),
      stageIndex: Number(item?.stageIndex || idx),
    })),
    stageCount,
    activeStageIndex: normalizedCurrentIndex,
    activePanelId: panel.panel_id,
    chartContext: {
      requestId: requestId || safeStage.requestId || null,
      originalQuestion: sanitizeText(question || safeStage.question, 280, ""),
      metricsShown: resolveStageMetrics(safeStage, bundle),
      chartTitle: safeStage.title,
      chartType: safeStage?.chartSpec?.chart_type || "list_summary",
      summaryBundle: null,
      panels: [{ panel_id: panel.panel_id, title: panel.title, goal: panel.goal, metrics: panel.metrics, index: 0 }],
      nextViews: nextViews,
      suggestedDrillDowns: suggestedFollowups.slice(0, 3),
    },
  };
}

module.exports = {
  buildStagePayload,
  buildCombinedVoiceAnswer,
  createStageRecord,
  getCurrentStage,
  getLatestStage,
  getStageByIndex,
  normalizeExecutorStageOutput,
  buildVoiceFirstFollowups,
  // Keep backward compat exports for any remaining references
  buildLegacyFallbackStage: createStageRecord,
  replayStoredStage: ({ bundle, stageIndex, question, requestId }) => {
    const stage = getStageByIndex(bundle, stageIndex);
    if (!stage) return { ok: false, stage: null, payload: null };
    const payload = buildStagePayload({ bundle, stageRecord: stage, question, requestId });
    return { ok: true, stage, payload };
  },
};
