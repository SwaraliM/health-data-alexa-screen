/**
 * backend/services/qna/stageService.js
 *
 * Stage helpers for phased QnA migration.
 * - Legacy qnaEngine outputs can be wrapped safely.
 * - Executor stage outputs are normalized into the same bundle format.
 * - Router payload compatibility is preserved without frontend rewrites.
 */

const {
  buildFallbackChartSpec,
  validateChartSpec,
} = require("../chartSpecService");
const { hydrateChartSpec } = require("../charts/chartPresetHydrator");

function sanitizeText(value, max = 420, fallback = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : fallback;
}

function safeJsonParseObject(value) {
  if (value == null) return null;
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
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

const DEFAULT_VOICE_COMMAND_FOLLOWUPS = [
  "show more",
  "yes",
  "go back",
  "explain that",
  "compare that",
  "what does this mean",
  "start over",
];

function ensureSentence(text = "") {
  const safe = sanitizeText(text, 320, "");
  if (!safe) return "";
  if (/[.!?]$/.test(safe)) return safe;
  return `${safe}.`;
}

function normalizeFollowupPhrase(value = "") {
  const raw = sanitizeText(value, 120, "").toLowerCase();
  if (!raw) return "";
  if (/^(next|show more|more|tell me more|go on|continue|yes|yeah|sure|ok|okay)$/.test(raw)) return "show more";
  if (/^(go back|back|previous|previous stage|last stage)$/.test(raw)) return "go back";
  if (/^(explain|explain that|explain this)$/.test(raw)) return "explain that";
  if (/^(compare|compare that|compare this)$/.test(raw)) return "compare that";
  if (/^(what does this mean|what does that mean)$/.test(raw)) return "what does this mean";
  if (/^(what stands out|why is that|what am i looking at)$/.test(raw)) return raw;
  if (/^(summarize|summarize this|quick recap)$/.test(raw)) return "summarize this";
  if (/^(start over|restart|reset)$/.test(raw)) return "start over";
  return raw;
}

function buildVoiceFirstFollowups(values = [], moreAvailable = false) {
  const normalized = uniqueList(
    (Array.isArray(values) ? values : []).map((item) => normalizeFollowupPhrase(item)).filter(Boolean),
    6
  );
  if (!normalized.length) {
    const defaults = moreAvailable
      ? DEFAULT_VOICE_COMMAND_FOLLOWUPS
      : DEFAULT_VOICE_COMMAND_FOLLOWUPS.filter((phrase) => phrase !== "show more");
    return uniqueList(defaults, 6);
  }
  const merged = [];
  if (moreAvailable) {
    merged.push("show more");
    if (!normalized.includes("yes")) merged.push("yes");
  }
  if (!normalized.includes("go back")) merged.push("go back");
  if (!normalized.includes("explain that")) merged.push("explain that");
  if (!normalized.includes("what does this mean")) merged.push("what does this mean");
  merged.push(...normalized);
  if (!moreAvailable) merged.push("start over");
  return uniqueList(merged, 6);
}

function getChartVisualSentence(chartSpec = null) {
  const chartType = String(chartSpec?.chart_type || "").toLowerCase();
  if (chartType.includes("bar")) return "The bars show how the values change across the time labels.";
  if (chartType.includes("line")) return "The line shows how the values move over time.";
  if (chartType.includes("scatter")) return "The points compare two measures and show how they move together.";
  if (chartType.includes("pie")) return "The slices show how each part contributes to the whole.";
  if (chartType.includes("gauge")) return "The gauge shows where your current value sits in the range.";
  if (chartType.includes("heatmap")) return "The color blocks show where values are higher or lower.";
  if (chartType.includes("timeline")) return "The timeline shows how your data changes step by step over time.";
  return "The chart shows your trend clearly in one view.";
}

function ensureNarratedScreenText({
  screenText = "",
  spokenText = "",
  chartSpec = null,
} = {}) {
  const candidate = sanitizeText(
    screenText || chartSpec?.takeaway || spokenText,
    700,
    "This chart highlights your latest health trend."
  );
  return ensureSentence(candidate);
}

function ensureNarratedSpokenText({
  spokenText = "",
  screenText = "",
  chartSpec = null,
  title = "Health insight",
} = {}) {
  let narrated = sanitizeText(spokenText, 640, "");
  const orientationSentence = ensureSentence(
    sanitizeText(`Here is what you see on the screen: ${title}.`, 220, "Here is what you see on the screen.")
  );
  const visualSentence = ensureSentence(getChartVisualSentence(chartSpec));
  const meaningSeed = sanitizeText(
    screenText || chartSpec?.takeaway || "this trend gives a clear direction for your next step",
    220,
    "this trend gives a clear direction for your next step"
  );
  const meaningSentence = ensureSentence(`What stands out is ${meaningSeed}`);
  const overallSentence = ensureSentence(`Overall, ${meaningSeed}`);

  if (!narrated) {
    return sanitizeText(`${orientationSentence} ${visualSentence} ${overallSentence}`, 640, orientationSentence);
  }

  if (!/\b(on the screen|you see|this chart)\b/i.test(narrated)) {
    narrated = `${orientationSentence} ${narrated}`;
  }
  if (!/\b(the bars|the line|the points|the slices|the chart|timeline|gauge|color)\b/i.test(narrated)) {
    narrated = `${narrated} ${visualSentence}`;
  }
  if (!/\b(what stands out|this means|overall|in short)\b/i.test(narrated)) {
    narrated = `${narrated} ${meaningSentence}`;
  }

  return sanitizeText(narrated, 640, `${orientationSentence} ${visualSentence} ${overallSentence}`);
}

function extractSuggestedFollowups(payload = {}) {
  const nextViewLabels = Array.isArray(payload?.next_views)
    ? payload.next_views.map((view) => view?.label).filter(Boolean)
    : [];
  const legacySuggested = Array.isArray(payload?.suggestedDrillDowns)
    ? payload.suggestedDrillDowns
    : Array.isArray(payload?.suggested_follow_up)
      ? payload.suggested_follow_up
      : [];
  return uniqueList([...nextViewLabels, ...legacySuggested], 6);
}

function extractScreenText(payload = {}, fallback = "") {
  return sanitizeText(
    payload?.summary?.shortText
      || payload?.takeaway
      || payload?.primary_visual?.takeaway
      || fallback,
    500,
    fallback
  );
}

function extractTitle(payload = {}, plannerResult = null) {
  return sanitizeText(
    payload?.report_title
      || payload?.primary_visual?.title
      || plannerResult?.analysisGoal
      || "Health insight",
    120,
    "Health insight"
  );
}

function createStageRecord({
  stageIndex = 0,
  title = "Health insight",
  spokenText = "",
  screenText = "",
  chartSpec = null,
  suggestedFollowups = [],
  moreAvailable = false,
  source = "legacy_qnaengine",
  requestId = null,
  question = "",
  metadata = null,
} = {}) {
  const now = new Date().toISOString();
  return {
    stageIndex: Math.max(0, Number(stageIndex) || 0),
    title: sanitizeText(title, 120, "Health insight"),
    spokenText: sanitizeText(spokenText, 640, ""),
    screenText: sanitizeText(screenText, 700, ""),
    chartSpec: chartSpec || null,
    suggestedFollowups: buildVoiceFirstFollowups(suggestedFollowups, moreAvailable),
    moreAvailable: Boolean(moreAvailable),
    source: sanitizeText(source, 40, "legacy_qnaengine"),
    requestId: requestId ? String(requestId) : null,
    question: sanitizeText(question, 280, ""),
    createdAt: now,
    updatedAt: now,
    metadata: metadata && typeof metadata === "object" ? metadata : {},
  };
}

function repairOptionString(raw) {
  if (!raw || typeof raw !== "string") return null;

  // Attempt 1: direct parse
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch (_) {}

  // Attempt 2: strip markdown fences GPT sometimes wraps around it
  const fenceStripped = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(fenceStripped);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch (_) {}

  // Attempt 3: extract outermost { } block (handles leading/trailing garbage)
  const braceMatch = fenceStripped.match(/(\{[\s\S]*\})/);
  if (braceMatch) {
    try {
      const parsed = JSON.parse(braceMatch[1]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch (_) {}
  }

  // Attempt 4: truncation repair — find last valid closing brace
  // Handles GPT output that was cut off mid-string
  for (let i = fenceStripped.length - 1; i > 0; i--) {
    if (fenceStripped[i] === "}") {
      try {
        const parsed = JSON.parse(fenceStripped.slice(0, i + 1));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          console.warn("[StageService] repairOptionString: recovered truncated option JSON");
          return parsed;
        }
      } catch (_) {}
    }
  }

  return null;
}

function normalizeChartSpec(chartSpec, title = "Health insight", spokenText = "", screenText = "") {
  if (!chartSpec || typeof chartSpec !== "object") {
    return buildFallbackChartSpec(
      sanitizeText(title, 80, "Health insight"),
      sanitizeText(screenText || spokenText, 180, "Here is your health insight.")
    );
  }

  // New path: chart_data present → hydrate from preset library
  if (chartSpec.chart_data && typeof chartSpec.chart_data === "object") {
    return hydrateChartSpec(chartSpec, sanitizeText(title, 80, "Health insight"));
  }

  // Legacy path: option already an object (old bundles in Mongo)
  if (chartSpec.option && typeof chartSpec.option === "object") {
    return validateChartSpec(chartSpec, sanitizeText(title, 80, "Health insight"));
  }

  // Legacy path: option is a string (very old bundles) — attempt repair
  if (typeof chartSpec.option === "string") {
    const repaired = repairOptionString(chartSpec.option);
    if (repaired) {
      return validateChartSpec(
        { ...chartSpec, option: repaired },
        sanitizeText(title, 80, "Health insight")
      );
    }
  }

  // Nothing worked — text fallback, stay in executor path
  console.warn("[StageService] normalizeChartSpec: no recoverable option → text fallback", {
    chartType: chartSpec.chart_type,
    title,
  });
  return buildFallbackChartSpec(
    sanitizeText(title, 80, "Health insight"),
    sanitizeText(chartSpec.takeaway || screenText || spokenText, 180, "Here is your health insight.")
  );
}

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
  const moreAvailable = rawMoreAvailable == null
    ? Boolean((Array.isArray(raw.suggested_followups) ? raw.suggested_followups : raw.suggestedFollowups)?.length)
    : Boolean(rawMoreAvailable);
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

function buildStageFromLegacyPayload({
  legacyResult = null,
  payload = null,
  plannerResult = null,
  stageIndex = 0,
  requestId = null,
  question = "",
  source = "legacy_qnaengine_stage1",
} = {}) {
  const resolvedPayload = payload || legacyResult?.payload || {};
  const title = extractTitle(resolvedPayload, plannerResult);
  const chartSpec = resolvedPayload?.chart_spec || resolvedPayload?.primary_visual || null;
  const moreAvailable = Boolean(
    resolvedPayload?.next_views?.length
    || resolvedPayload?.hasNextStage
    || resolvedPayload?.more_available
  );
  const screenText = ensureNarratedScreenText({
    screenText: extractScreenText(resolvedPayload, ""),
    spokenText: resolvedPayload?.voice_answer || resolvedPayload?.spoken_answer || legacyResult?.voiceAnswer || "",
    chartSpec,
  });
  const spokenText = ensureNarratedSpokenText({
    spokenText: resolvedPayload?.voice_answer || resolvedPayload?.spoken_answer || legacyResult?.voiceAnswer || "",
    screenText,
    chartSpec,
    title,
  });
  const suggestedFollowups = buildVoiceFirstFollowups(
    extractSuggestedFollowups(resolvedPayload),
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
      plannerMode: plannerResult?.mode || null,
      plannerTimeScope: plannerResult?.timeScope || null,
      candidateStageTypes: Array.isArray(plannerResult?.candidateStageTypes)
        ? plannerResult.candidateStageTypes
        : [],
    },
  });
}

function buildLegacyFallbackStage({
  legacyResult = null,
  payload = null,
  plannerResult = null,
  stageIndex = 0,
  requestId = null,
  question = "",
} = {}) {
  return buildStageFromLegacyPayload({
    legacyResult,
    payload,
    plannerResult,
    stageIndex,
    requestId,
    question,
    source: "legacy_qnaengine_fallback",
  });
}

function appendStageToBundleFormat(bundleStages = [], stageRecord = null) {
  const existing = Array.isArray(bundleStages) ? bundleStages.slice() : [];
  if (!stageRecord || typeof stageRecord !== "object") return existing;
  const nextIndex = stageRecord.stageIndex == null
    ? existing.length
    : Math.max(0, Number(stageRecord.stageIndex) || 0);
  const next = { ...stageRecord, stageIndex: nextIndex };
  const replaceIndex = existing.findIndex((stage) => Number(stage?.stageIndex) === nextIndex);
  if (replaceIndex >= 0) existing[replaceIndex] = next;
  else existing.push(next);

  existing.sort((a, b) => Number(a?.stageIndex || 0) - Number(b?.stageIndex || 0));
  return existing;
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

function getStageByIndex(bundle = null, stageIndex = null) {
  if (!bundle || typeof bundle !== "object") return null;
  const stages = Array.isArray(bundle.stages) ? bundle.stages : [];
  if (!stages.length) return null;

  const normalizedStageIndex = Math.max(0, Number(stageIndex) || 0);
  return stages.find((stage) => Number(stage?.stageIndex) === normalizedStageIndex) || null;
}

function hasStoredStage(bundle = null, stageIndex = null) {
  return Boolean(getStageByIndex(bundle, stageIndex));
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

function normalizeRequestedStageIndex(input = null, maxStageIndex = 0) {
  const upperBound = Math.max(0, Number(maxStageIndex) || 0);
  if (typeof input === "number" && Number.isFinite(input)) {
    return Math.min(upperBound, Math.max(0, Math.floor(input)));
  }

  const raw = String(input == null ? "" : input).trim().toLowerCase();
  if (!raw) return upperBound;
  if (raw === "latest" || raw === "current" || raw === "now") return upperBound;

  const parsed = Number(raw.replace(/[^\d-]/g, ""));
  if (!Number.isFinite(parsed)) return upperBound;
  return Math.min(upperBound, Math.max(0, Math.floor(parsed)));
}

function getNextStageIndex(bundle = null) {
  if (!bundle || typeof bundle !== "object") return 0;
  const stages = Array.isArray(bundle.stages) ? bundle.stages : [];
  if (!stages.length) return 0;
  const currentIndex = Number.isFinite(Number(bundle.currentStageIndex))
    ? Math.max(0, Number(bundle.currentStageIndex))
    : Number(stages[stages.length - 1]?.stageIndex || 0);
  return Math.max(currentIndex + 1, stages.length);
}

function hasMoreStages(bundle = null, stageRecord = null) {
  if (stageRecord && typeof stageRecord === "object") {
    return Boolean(stageRecord.moreAvailable);
  }
  const stage = getCurrentStage(bundle) || getLatestStage(bundle);
  return Boolean(stage?.moreAvailable);
}

function buildCompletionState({
  bundle = null,
  stageRecord = null,
  completeWhenDone = false,
} = {}) {
  const stage = stageRecord || getCurrentStage(bundle) || getLatestStage(bundle);
  const stageIndex = Math.max(0, Number(stage?.stageIndex || 0));
  const stageCount = Array.isArray(bundle?.stagesPlan) && bundle.stagesPlan.length
    ? bundle.stagesPlan.length
    : Array.isArray(bundle?.plannerOutput?.candidate_stage_types) && bundle.plannerOutput.candidate_stage_types.length
      ? bundle.plannerOutput.candidate_stage_types.length
      : Array.isArray(bundle?.stages) ? bundle.stages.length : (stage ? 1 : 0);
  const moreAvailable = hasMoreStages(bundle, stage);
  const bundleStatus = moreAvailable
    ? "partial"
    : (completeWhenDone ? "completed" : "ready");

  return {
    stageIndex,
    stageCount,
    moreAvailable,
    done: !moreAvailable,
    bundleStatus,
  };
}

function buildStageResponse({
  bundle = null,
  stageRecord = null,
  question = "",
  requestId = null,
  voiceAnswerSource = "gpt",
  completeWhenDone = false,
} = {}) {
  const payload = buildStagePayload({
    bundle,
    stageRecord,
    question,
    requestId,
    voiceAnswerSource,
  });
  const completionState = buildCompletionState({
    bundle,
    stageRecord,
    completeWhenDone,
  });
  return {
    payload,
    completionState,
  };
}

function buildStagePayload({
  bundle = null,
  stageRecord = null,
  question = "",
  requestId = null,
  voiceAnswerSource = "gpt",
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
    safeStage.suggestedFollowups || safeStage.suggested_follow_up || [],
    safeStage.moreAvailable
  ).slice(0, 4);
  const nextViews = suggestedFollowups.map((label, idx) => ({
    id: `stage_${normalizedCurrentIndex}_next_${idx + 1}`,
    label,
    goal: "deep_dive",
    metrics: Array.isArray(bundle?.metricsRequested) ? bundle.metricsRequested.slice(0, 4) : ["steps"],
    visual_family: safeStage?.chartSpec?.chart_type || "list_summary",
  }));

  const chartSpecForPanel = (safeStage.chartSpec && typeof safeStage.chartSpec === "object")
    ? normalizeChartSpec(
        safeStage.chartSpec,
        safeStage.title || "Health insight",
        safeStage.spokenText || "",
        safeStage.screenText || ""
      )
    : buildFallbackChartSpec(
        safeStage.title || "Health insight",
        safeStage.screenText || safeStage.spokenText || "No chart."
      );

  const panel = {
    panel_id: `stage_${normalizedCurrentIndex}`,
    title: safeStage.title,
    subtitle: "",
    goal: "deep_dive",
    metrics: Array.isArray(bundle?.metricsRequested) ? bundle.metricsRequested.slice(0, 4) : ["steps"],
    visual_family: chartSpecForPanel?.chart_type || "list_summary",
    chart_spec: chartSpecForPanel,
  };

  const bundleComplete = safeStage.moreAvailable === false;
  const completionOffer = bundleComplete
    ? " That completes the analysis. You can ask me a new health question, or say go deeper to explore this topic further."
    : "";

  // ── Position context prefix for voice (Gap 2) ──────────────────────────────
  // When there are multiple charts, prefix with "Chart X of Y." so Alexa
  // clearly orients the user in the sequential reveal flow.
  // Also append a navigation cue on non-final charts so the user knows what to say.
  const stageCountForVoice = (() => {
    const planned = Array.isArray(bundle?.stagesPlan) && bundle.stagesPlan.length
      ? bundle.stagesPlan.length
      : Array.isArray(bundle?.plannerOutput?.candidate_stage_types)
        ? bundle.plannerOutput.candidate_stage_types.length
        : 0;
    const cap = 6;
    const knownCount = planned > 0 ? Math.min(planned, cap) : Math.max(stages.length, 1);
    if (safeStage.moreAvailable && knownCount <= normalizedCurrentIndex + 1) {
      return normalizedCurrentIndex + 2;
    }
    return knownCount;
  })();
  const positionPrefix = stageCountForVoice > 1
    ? `Chart ${normalizedCurrentIndex + 1} of ${stageCountForVoice}. `
    : "";
  const navigationCue = !bundleComplete && stageCountForVoice > 1
    ? " Say next for the next chart."
    : "";
  const fullVoiceAnswer = positionPrefix + safeStage.spokenText + completionOffer + navigationCue;
  // ── End position context ───────────────────────────────────────────────────

  return {
    status: "ready",
    requestId: requestId || safeStage.requestId || null,
    interaction_mode: "voice_first",
    navigation_mode: "voice_only",
    voice_navigation_only: true,
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
      speech: sanitizeText(item?.spokenText, 700, ""),
      voice_answer: sanitizeText(item?.spokenText, 700, ""),
      screen_text: sanitizeText(item?.screenText, 320, ""),
      chart_spec: item?.chartSpec || null,
      summary: sanitizeText(item?.screenText, 240, ""),
      title: sanitizeText(item?.title, 120, "Health insight"),
      stageIndex: Number(item?.stageIndex || idx),
    })),
    stageCount: (() => {
      const planned = Array.isArray(bundle?.stagesPlan) && bundle.stagesPlan.length
        ? bundle.stagesPlan.length
        : Array.isArray(bundle?.plannerOutput?.candidate_stage_types)
          ? bundle.plannerOutput.candidate_stage_types.length
          : 0;
      const cap = 6;
      const knownCount = planned > 0 ? Math.min(planned, cap) : Math.max(stages.length, 1);
      // When more stages are coming, guarantee the count is at least currentIndex+2
      // so the lambda show_more gate never prematurely blocks navigation.
      if (safeStage.moreAvailable && knownCount <= normalizedCurrentIndex + 1) {
        return normalizedCurrentIndex + 2;
      }
      return knownCount;
    })(),
    activeStageIndex: normalizedCurrentIndex,
    activePanelId: panel.panel_id,
    chartContext: {
      requestId: requestId || safeStage.requestId || null,
      originalQuestion: sanitizeText(question || safeStage.question, 280, ""),
      metricsShown: Array.isArray(bundle?.metricsRequested) ? bundle.metricsRequested.slice(0, 4) : ["steps"],
      chartTitle: safeStage.title,
      chartType: safeStage?.chartSpec?.chart_type || "list_summary",
      summaryBundle: null,
      panels: [
        {
          panel_id: panel.panel_id,
          title: panel.title,
          goal: panel.goal,
          metrics: panel.metrics,
          index: 0,
        },
      ],
      nextViews: nextViews,
      suggestedDrillDowns: suggestedFollowups.slice(0, 3),
    },
  };
}

function extractStageSummary(stageRecord = {}) {
  return {
    stageIndex: Number(stageRecord?.stageIndex || 0),
    title: sanitizeText(stageRecord?.title, 120, ""),
    moreAvailable: Boolean(stageRecord?.moreAvailable),
    source: sanitizeText(stageRecord?.source, 40, ""),
    hasChartSpec: Boolean(stageRecord?.chartSpec),
    createdAt: stageRecord?.createdAt || null,
  };
}

function buildReplayResponse({
  stage = null,
  bundle = null,
  question = "",
  requestId = null,
  voiceAnswerSource = "gpt",
} = {}) {
  if (!stage || typeof stage !== "object") return null;
  return buildStagePayload({
    bundle,
    stageRecord: stage,
    question: sanitizeText(question, 280, ""),
    requestId,
    voiceAnswerSource: sanitizeText(voiceAnswerSource, 20, "gpt"),
  });
}

function replayStoredStage({
  bundle = null,
  stageIndex = null,
  question = "",
  requestId = null,
  voiceAnswerSource = "gpt",
} = {}) {
  if (!bundle || typeof bundle !== "object") {
    return {
      ok: false,
      reason: "missing_bundle",
      stage: null,
      payload: null,
    };
  }

  const latestStage = getLatestStage(bundle);
  const maxStageIndex = Number(latestStage?.stageIndex || 0);
  let targetStageIndex = maxStageIndex;
  if (stageIndex != null && stageIndex !== "") {
    const raw = String(stageIndex).trim().toLowerCase();
    if (["latest", "current", "now"].includes(raw)) {
      targetStageIndex = maxStageIndex;
    } else {
      const parsed = Number(raw.replace(/[^\d-]/g, ""));
      targetStageIndex = Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : maxStageIndex;
    }
  }
  const stage = getStageByIndex(bundle, targetStageIndex);

  if (!stage) {
    return {
      ok: false,
      reason: "stage_not_found",
      stageIndex: targetStageIndex,
      stage: null,
      payload: null,
    };
  }

  const payload = buildReplayResponse({
    stage,
    bundle,
    question,
    requestId,
    voiceAnswerSource,
  });

  return {
    ok: true,
    reason: "replayed_stored_stage",
    stageIndex: Number(stage.stageIndex || 0),
    stage,
    payload,
    stageSummary: extractStageSummary(stage),
  };
}

module.exports = {
  appendStageToBundleFormat,
  buildLegacyFallbackStage,
  buildReplayResponse,
  buildStagePayload,
  buildStageFromLegacyPayload,
  createStageRecord,
  extractStageSummary,
  hasMoreStages,
  getCurrentStage,
  getLatestStage,
  getStageByIndex,
  getNextStageIndex,
  hasStoredStage,
  buildCompletionState,
  buildStageResponse,
  normalizeRequestedStageIndex,
  normalizeExecutorStageOutput,
  replayStoredStage,
};
