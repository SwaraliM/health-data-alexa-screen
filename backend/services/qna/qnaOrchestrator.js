/**
 * backend/services/qna/qnaOrchestrator.js
 *
 * Clean 3-step pipeline coordinator:
 *   1. classifyIntent → planQuestion (LLM decides metrics + stages)
 *   2. fetchAndComputeEvidence (Fitbit data + statistical evidence)
 *   3. generateAllStages (parallel chart generation via Promise.all)
 *
 * Three exports: handleQuestion, handleNavigation, resumePending
 */

"use strict";

const mongoose = require("mongoose");
const User = require("../../models/Users");
const { classifyIntent } = require("./intentClassifierService");
const { planQuestion } = require("./plannerAgent");
const { generateAllStages } = require("./executorAgent");
const { fetchAndComputeEvidence } = require("./dataFetchService");
const {
  buildStageResult,
  buildPendingResponse,
  buildTerminalResponse,
} = require("./responseBuilder");
const {
  appendStage,
  archiveOlderActiveBundles,
  createBundle,
  getBundleById,
  loadActiveBundleForUser,
  loadLatestCompletedBundleForUser,
  saveBundlePatch,
  setBundleStatus,
  setCurrentStageIndex: setBundleStageIndex,
  storePlannerResult,
  toStoredPlannerResult,
} = require("./bundleService");
const { recordSessionAudit } = require("./auditService");
const { buildStagePayload, getStageByIndex } = require("./stageService");

const DEBUG = process.env.QNA_ORCHESTRATOR_DEBUG !== "false";
const LIFECYCLE_POLICY = String(process.env.QNA_BUNDLE_LIFECYCLE_POLICY || "archive").toLowerCase();

// ── In-memory state: one entry per user ──────────────────────────────────────
// Replaces RUNTIME_STAGE_REQUESTS, sessionService, and router-level Maps.
const activeJobs = new Map();

function log(msg, data = null) {
  if (!DEBUG) return;
  if (data == null) return console.log(`[QnaOrchestrator] ${msg}`);
  console.log(`[QnaOrchestrator] ${msg}`, data);
}

function warn(msg, data = null) {
  if (data == null) return console.warn(`[QnaOrchestrator] ${msg}`);
  console.warn(`[QnaOrchestrator] ${msg}`, data);
}

function sanitizeText(value, max = 220, fallback = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : fallback;
}

function normalizeUsername(username = "") {
  return String(username || "").trim().toLowerCase();
}

function createInteractionState({
  mode = "idle",
  bundleId = null,
  requestId = null,
  currentStageIndex = 0,
  stageCount = 0,
  originalQuestion = "",
  lastTurnType = "",
  lastDeliveredFingerprint = "",
  generationStartedAt = null,
  readyAt = null,
} = {}) {
  return {
    mode,
    bundleId: bundleId || null,
    requestId: requestId || null,
    currentStageIndex: Math.max(0, Number(currentStageIndex) || 0),
    stageCount: Math.max(0, Number(stageCount) || 0),
    originalQuestion: sanitizeText(originalQuestion, 320, ""),
    lastTurnType: sanitizeText(lastTurnType, 40, ""),
    lastDeliveredFingerprint: String(lastDeliveredFingerprint || "").trim(),
    generationStartedAt: generationStartedAt || null,
    readyAt: readyAt || null,
  };
}

function ensureJobInteraction(job, patch = null) {
  if (!job || typeof job !== "object") return createInteractionState();
  const current = createInteractionState(job.interaction || {});
  const next = patch && typeof patch === "object"
    ? createInteractionState({ ...current, ...patch })
    : current;
  job.interaction = next;
  return next;
}

function setJobInteraction(username, patch = null) {
  const safeUsername = normalizeUsername(username);
  const job = activeJobs.get(safeUsername);
  if (!job) return null;
  return ensureJobInteraction(job, patch);
}

function buildDeliveryFingerprint(requestId = null, stageIndex = 0) {
  const safeRequestId = String(requestId || "").trim();
  if (!safeRequestId) return "";
  return `${safeRequestId}:${Math.max(0, Number(stageIndex) || 0)}`;
}

async function getActiveRuntime(username) {
  const safeUsername = normalizeUsername(username);
  const job = activeJobs.get(safeUsername) || null;
  let bundle = null;
  let stages = [];
  let currentIndex = 0;

  if (job?.bundleId) {
    bundle = await getBundleById(job.bundleId);
    stages = job.stages.length ? job.stages : (Array.isArray(bundle?.stages) ? bundle.stages : []);
    currentIndex = Number(job.currentChartIndex || job.interaction?.currentStageIndex || 0);
  } else {
    bundle = await loadActiveBundleForUser(safeUsername);
    if (bundle) {
      stages = Array.isArray(bundle.stages) ? bundle.stages : [];
      currentIndex = Number(bundle.currentStageIndex || 0);
    }
  }

  return {
    username: safeUsername,
    job,
    bundle,
    stages,
    currentIndex: Math.max(0, Number(currentIndex) || 0),
  };
}

async function getInteractionState(username) {
  const { job, bundle, stages, currentIndex } = await getActiveRuntime(username);
  if (job?.interaction) {
    const stageCount = Math.max(
      Number(job.interaction.stageCount || 0),
      Array.isArray(stages) ? stages.length : 0
    );
    return createInteractionState({
      ...job.interaction,
      bundleId: job.bundleId || job.interaction.bundleId || bundle?.bundleId || null,
      currentStageIndex: currentIndex,
      stageCount,
    });
  }

  if (bundle?.bundleId) {
    const stageCount = Array.isArray(stages) ? stages.length : 0;
    return createInteractionState({
      mode: stageCount > 0 ? "ready_to_deliver" : "generating",
      bundleId: bundle.bundleId,
      requestId: bundle?.lineage?.activeRequestKey || null,
      currentStageIndex: currentIndex,
      stageCount,
      originalQuestion: bundle.question || "",
      readyAt: stageCount > 0 ? (bundle.updatedAt || new Date().toISOString()) : null,
    });
  }

  return createInteractionState();
}

async function markStageDelivered({
  username,
  requestId = null,
  stageIndex = 0,
  stageCount = 0,
  bundleComplete = false,
  turnType = "delivery",
} = {}) {
  const { job, bundle } = await getActiveRuntime(username);
  const nextMode = bundleComplete ? "complete" : "awaiting_continue";
  const patch = {
    mode: nextMode,
    bundleId: job?.bundleId || bundle?.bundleId || null,
    requestId: requestId || job?.interaction?.requestId || bundle?.lineage?.activeRequestKey || null,
    currentStageIndex: stageIndex,
    stageCount: Math.max(0, Number(stageCount) || 0),
    lastTurnType: turnType,
    lastDeliveredFingerprint: buildDeliveryFingerprint(requestId, stageIndex),
    readyAt: job?.interaction?.readyAt || new Date().toISOString(),
  };

  if (job) {
    job.currentChartIndex = Math.max(0, Number(stageIndex) || 0);
    ensureJobInteraction(job, patch);
  }

  return createInteractionState({
    ...(job?.interaction || {}),
    ...patch,
  });
}

async function getUserContext(username) {
  try {
    const user = await User.findOne({ username: String(username || "").toLowerCase() });
    if (!user) return null;
    return {
      age: user?.userProfile?.age || null,
      healthGoals: Array.isArray(user?.userProfile?.healthGoals) ? user.userProfile.healthGoals : [],
      preferences: {
        dailyStepGoal: Number(user?.userProfile?.preferences?.dailyStepGoal) || 10000,
        sleepGoalMinutes: Number(user?.userProfile?.preferences?.sleepGoalMinutes) || 480,
      },
    };
  } catch (error) {
    warn("failed to load user context", { message: error?.message || String(error) });
    return null;
  }
}

// ── handleQuestion: the 3-step pipeline ──────────────────────────────────────

/**
 * Process a new health question through the full pipeline.
 *
 * @param {object} opts
 * @param {string} opts.username
 * @param {string} opts.question - Raw user question text
 * @param {string} [opts.requestId]
 * @param {string} [opts.requestSource] - "alexa" | "browser"
 * @returns {Promise<object>} Result with voice_answer, payload, etc.
 */
async function handleQuestion({
  username,
  question,
  requestId = null,
  requestSource = "alexa",
} = {}) {
  const safeUsername = normalizeUsername(username);
  const safeQuestion = sanitizeText(question, 320, "");
  const safeRequestId = requestId || `req_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;

  log("handleQuestion start", { username: safeUsername, question: safeQuestion });

  // Mark job as in-progress immediately so resumePending knows something is running
  const job = {
    bundleId: null,
    promise: null,
    stages: [],
    stagesPlan: [],
    currentChartIndex: 0,
    complete: false,
    startedAt: Date.now(),
    interaction: createInteractionState({
      mode: "generating",
      requestId: safeRequestId,
      currentStageIndex: 0,
      stageCount: 0,
      originalQuestion: safeQuestion,
      lastTurnType: "new_health_question",
      generationStartedAt: new Date().toISOString(),
    }),
  };
  activeJobs.set(safeUsername, job);

  // Wrap the pipeline in a promise so the router can race it against a timeout
  // while the pipeline continues running in the background.
  const pipelinePromise = (async () => {
    try {
      // Step 0: Classify intent (detect navigation vs question)
      const enrichedIntent = await classifyIntent(safeQuestion, {}).catch(() => null);

      // If the classifier says this is navigation, handle it directly
      // (no clearRuntimeState — preserve in-memory job for navigation)
      if (enrichedIntent?.is_navigation) {
        const navAction = String(enrichedIntent?.control_action || "show_more").trim().toLowerCase();
        return handleNavigation({ username: safeUsername, action: navAction, requestId: safeRequestId });
      }

      // Clear stale state only for genuine new questions (not navigation).
      // Re-insert the current job so resumePending can find it while the pipeline runs.
      activeJobs.delete(safeUsername);
      activeJobs.set(safeUsername, job);

      // Step 1: Plan — LLM decides metrics, sub-analyses, and stages
      const userContext = await getUserContext(safeUsername);
      const plannerResult = await planQuestion({
        question: safeQuestion,
        username: safeUsername,
        enrichedIntent,
        userContext,
      });

      log("planner completed", {
        metrics: plannerResult.metricsNeeded,
        stageCount: plannerResult.stagesPlan?.length,
        hasSubAnalyses: Boolean(plannerResult.subAnalyses),
      });

      // Create bundle in MongoDB
      const bundle = await createBundle({
        username: safeUsername,
        question: safeQuestion,
        displayLabel: sanitizeText(enrichedIntent?.display_label || "", 40, ""),
        plannerOutput: toStoredPlannerResult(plannerResult),
        metricsRequested: plannerResult.metricsNeeded || [],
        status: "active",
        requestKey: safeRequestId,
        requestSource,
      });
      await storePlannerResult(bundle.bundleId, {
        ...toStoredPlannerResult(plannerResult),
        plannerMeta: { ...(plannerResult?.plannerMeta || {}), phase: "single_pipeline" },
      });
      if (Array.isArray(plannerResult?.stagesPlan) && plannerResult.stagesPlan.length) {
        await saveBundlePatch(bundle.bundleId, { stagesPlan: plannerResult.stagesPlan });
      }
      await archiveOlderActiveBundles(safeUsername, bundle.bundleId, `pipeline_${LIFECYCLE_POLICY}`);

      job.bundleId = bundle.bundleId;
      job.stagesPlan = plannerResult.stagesPlan || [];
      ensureJobInteraction(job, {
        mode: "generating",
        bundleId: bundle.bundleId,
        requestId: safeRequestId,
        currentStageIndex: 0,
        stageCount: Array.isArray(plannerResult?.stagesPlan) ? plannerResult.stagesPlan.length : 0,
        originalQuestion: safeQuestion,
        lastTurnType: "new_health_question",
      });

      // Build sub-analyses — use V3 sub_analyses if planner provided them,
      // otherwise synthesize a single sub-analysis from flat metrics
      let subAnalyses = plannerResult.subAnalyses || plannerResult.sub_analyses || null;
      if (!Array.isArray(subAnalyses) || !subAnalyses.length) {
        subAnalyses = [{
          id: "sa_primary",
          label: plannerResult.analysisGoal || safeQuestion,
          metrics_needed: plannerResult.metricsNeeded || [],
          time_scope: plannerResult.timeScope || "last_7_days",
          analysis_type: "primary",
        }];
      }

      // Step 2: Fetch data + compute evidence
      const { multiWindowData, evidenceBundle } = await fetchAndComputeEvidence({
        bundle,
        username: safeUsername,
        subAnalyses,
      });

      log("data fetched and evidence computed", {
        bundleId: bundle.bundleId,
        subAnalyses: Object.keys(multiWindowData).length,
      });

      // Step 3: Generate ALL stages in parallel
      const stagesPlan = plannerResult.stagesPlan || [];
      const generationResult = await generateAllStages({
        bundle: await getBundleById(bundle.bundleId) || bundle,
        question: safeQuestion,
        stagesPlan,
        userContext,
        requestId: safeRequestId,
        multiWindowData,
        evidenceBundle,
      });

      if (!generationResult.ok || !generationResult.stages.length) {
        warn("all stage generation failed", { errors: generationResult.errors });
        job.complete = true;
        ensureJobInteraction(job, {
          mode: "idle",
          stageCount: 0,
          readyAt: null,
          lastTurnType: "generation_failed",
        });
        return buildPendingResponse({
          bundle,
          requestId: safeRequestId,
          voiceAnswer: "I had trouble generating your health charts. Please try again.",
        });
      }

      // Persist all stages to MongoDB at once
      const resolvedBundle = await getBundleById(bundle.bundleId) || bundle;
      for (const stage of generationResult.stages) {
        await appendStage(bundle.bundleId, stage, { requestKey: safeRequestId });
      }
      await setBundleStatus(bundle.bundleId, "ready", {}, "all_stages_generated", {
        requestKey: safeRequestId,
      });
      await setBundleStageIndex(bundle.bundleId, 0, { requestKey: safeRequestId });

      // Update job state
      job.stages = generationResult.stages;
      job.complete = true;
      ensureJobInteraction(job, {
        mode: "ready_to_deliver",
        bundleId: bundle.bundleId,
        requestId: safeRequestId,
        currentStageIndex: 0,
        stageCount: generationResult.stages.length,
        originalQuestion: safeQuestion,
        lastTurnType: "generation_complete",
        readyAt: new Date().toISOString(),
      });

      log("all stages generated", {
        bundleId: bundle.bundleId,
        stageCount: generationResult.stages.length,
      });

      recordSessionAudit?.({
        eventType: "pipeline_complete",
        username: safeUsername,
        bundleId: bundle.bundleId,
        requestKey: safeRequestId,
        stageCount: generationResult.stages.length,
      });

      // Return stage 0
      const freshBundle = await getBundleById(bundle.bundleId) || resolvedBundle;
      return buildStageResult({
        bundle: freshBundle,
        stage: generationResult.stages[0],
        requestId: safeRequestId,
        stageCount: generationResult.stages.length,
      });
    } catch (error) {
      console.error("[QnaOrchestrator] pipeline failed", {
        message: error?.message || String(error),
        stack: error?.stack || null,
      });
      job.complete = true;
      ensureJobInteraction(job, {
        mode: "idle",
        bundleId: job.bundleId || null,
        requestId: safeRequestId,
        lastTurnType: "error",
      });
      return {
        ok: false,
        status: "error",
        answer_ready: false,
        voice_answer: "I had trouble gathering your health data. Please try again.",
        requestId: safeRequestId,
        payload: null,
      };
    }
  })();

  job.promise = pipelinePromise;
  return pipelinePromise;
}

// ── handleNavigation: index into pre-generated stages ────────────────────────

/**
 * Handle navigation commands (next, back, start_over) by indexing into
 * the pre-generated stages array.
 *
 * @param {object} opts
 * @param {string} opts.username
 * @param {string} opts.action - "show_more" | "back" | "start_over"
 * @param {string} [opts.requestId]
 * @returns {Promise<object>}
 */
async function handleNavigation({
  username,
  action,
  requestId = null,
} = {}) {
  const safeUsername = normalizeUsername(username);
  const { job, bundle: runtimeBundle, stages: runtimeStages, currentIndex: runtimeIndex } = await getActiveRuntime(safeUsername);
  let bundle = runtimeBundle;
  let stages = runtimeStages;
  let currentIndex = runtimeIndex;

  if (!bundle?.bundleId || !stages.length) {
    return buildPendingResponse({
      requestId,
      voiceAnswer: "I don't have an active analysis yet. Ask a health question first.",
    });
  }

  const stageCount = stages.length;
  let targetIndex = currentIndex;

  if (action === "show_more" || action === "stage_next" || action === "next") {
    targetIndex = currentIndex + 1;
  } else if (action === "back" || action === "stage_back") {
    targetIndex = Math.max(0, currentIndex - 1);
  } else if (action === "start_over") {
    targetIndex = 0;
  }

  // Clamp to valid range
  if (targetIndex >= stageCount) {
    return buildTerminalResponse({ bundle, requestId, stageCount });
  }
  targetIndex = Math.max(0, Math.min(targetIndex, stageCount - 1));

  // Look up the stage — first try in-memory, then MongoDB
  let stage = stages.find((s) => Number(s?.stageIndex) === targetIndex) || null;
  if (!stage) {
    stage = getStageByIndex(bundle, targetIndex);
  }

  if (!stage) {
    // Stage not yet generated — wait briefly for in-flight pipeline
    if (job?.promise && !job.complete) {
      await Promise.race([
        job.promise,
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
      // Re-check after wait
      stage = job.stages.find((s) => Number(s?.stageIndex) === targetIndex) || null;
      if (!stage) {
        const freshBundle = await getBundleById(bundle.bundleId);
        stage = getStageByIndex(freshBundle, targetIndex);
        if (freshBundle) bundle = freshBundle;
      }
    }
  }

  if (!stage) {
    return buildPendingResponse({
      bundle,
      requestId,
      voiceAnswer: "Hang on, I'm still preparing the next chart.",
      activeStageIndex: currentIndex,
      stageCount,
    });
  }

  // Update current index
  if (job) job.currentChartIndex = targetIndex;
  await setBundleStageIndex(bundle.bundleId, targetIndex, { requestKey: requestId });
  if (job) {
    ensureJobInteraction(job, {
      mode: "ready_to_deliver",
      bundleId: bundle.bundleId,
      requestId: requestId || job.interaction?.requestId || bundle?.lineage?.activeRequestKey || null,
      currentStageIndex: targetIndex,
      stageCount,
      lastTurnType: "navigation",
      readyAt: new Date().toISOString(),
    });
  }

  return buildStageResult({
    bundle,
    stage,
    requestId,
    stageCount,
  });
}

// ── resumePending: check if in-flight pipeline has completed ─────────────────

/**
 * Check whether a pending pipeline has completed for this user.
 * Called by the router when Lambda polls with tryAgain=true.
 *
 * @param {string} username
 * @returns {Promise<object|null>} Result if ready, null if still running
 */
async function resumePending(username) {
  const safeUsername = normalizeUsername(username);
  const { job, bundle: runtimeBundle, stages: runtimeStages, currentIndex: runtimeIndex } = await getActiveRuntime(safeUsername);

  if (!job) {
    // No active job — check MongoDB for a ready bundle
    const bundle = runtimeBundle || await loadActiveBundleForUser(safeUsername);
    if (bundle && Array.isArray(bundle.stages) && bundle.stages.length > 0) {
      const currentStageIndex = runtimeStages.length ? runtimeIndex : Number(bundle.currentStageIndex || 0);
      const stage = getStageByIndex(bundle, currentStageIndex) || bundle.stages[0];
      if (stage) {
        return buildStageResult({
          bundle,
          stage,
          stageCount: bundle.stages.length,
        });
      }
    }

    // MongoDB fallback — if the in-memory activeJobs entry was lost (process restart or wiped
    // by a new question), check MongoDB for the user's most recently completed bundle so the
    // session can recover.
    const completedBundle = await loadLatestCompletedBundleForUser(safeUsername);
    if (completedBundle && Array.isArray(completedBundle.stages) && completedBundle.stages.length > 0) {
      const currentIndex = Number(completedBundle.currentStageIndex || 0);
      const stage = getStageByIndex(completedBundle, currentIndex) || completedBundle.stages[0];
      if (stage) {
        return buildStageResult({
          bundle: completedBundle,
          stage,
          stageCount: completedBundle.stages.length,
        });
      }
    }

    return null;
  }

  if (job.complete && job.stages.length > 0) {
    const bundle = runtimeBundle || (job.bundleId ? await getBundleById(job.bundleId) : null);
    const stage = job.stages[job.currentChartIndex] || job.stages[0];
    ensureJobInteraction(job, {
      mode: "ready_to_deliver",
      bundleId: bundle?.bundleId || job.bundleId || null,
      currentStageIndex: Number(job.currentChartIndex || 0),
      stageCount: job.stages.length,
      lastTurnType: "resume_pending",
      readyAt: job.interaction?.readyAt || new Date().toISOString(),
    });
    return buildStageResult({
      bundle,
      stage,
      stageCount: job.stages.length,
    });
  }

  // Pipeline still running — return null immediately so backend sends "Still working on that"
  // on every poll. Alexa's progressive response mechanism handles the filler speech cycle.
  return null;
}

// ── clearRuntimeState: cleanup ───────────────────────────────────────────────

function clearRuntimeState(username = null) {
  if (!username) {
    activeJobs.clear();
    return;
  }
  activeJobs.delete(normalizeUsername(username));
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  getInteractionState,
  handleQuestion,
  handleNavigation,
  markStageDelivered,
  resumePending,
  clearRuntimeState,
  // Aliases for backward compat with router
  startQuestionWithOrchestrator: handleQuestion,
  handleQuestionWithOrchestrator: handleQuestion,
  handleControlWithOrchestrator: async ({ username, action, requestId, sessionHints } = {}) => {
    const normalizedAction = String(action || "").trim().toLowerCase();
    if (normalizedAction === "resume_pending" || normalizedAction === "poll_pending") {
      return resumePending(username) || buildPendingResponse({
        voiceAnswer: "Hang on, I'm still preparing the next chart.",
      });
    }
    return handleNavigation({ username, action: normalizedAction, requestId });
  },
};
