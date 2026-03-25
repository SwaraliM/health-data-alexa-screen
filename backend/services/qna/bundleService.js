/**
 * backend/services/qna/bundleService.js
 *
 * Bundle persistence helpers used by the incremental orchestrator migration.
 * The service keeps explicit transition logs for auditability/debuggability.
 */

const crypto = require("crypto");
const QnaBundle = require("../../models/QnaBundle");

const BUNDLE_DEBUG = process.env.QNA_BUNDLE_DEBUG !== "false";
const ACTIVE_LOOKUP_STATUSES = ["active", "partial", "ready"];
const VALID_STATUSES = ["active", "partial", "ready", "completed", "archived", "released", "failed"];

function bundleLog(message, data = null) {
  if (!BUNDLE_DEBUG) return;
  if (data == null) return console.log(`[BundleService] ${message}`);
  console.log(`[BundleService] ${message}`, data);
}

function bundleWarn(message, data = null) {
  if (data == null) return console.warn(`[BundleService] ${message}`);
  console.warn(`[BundleService] ${message}`, data);
}

function bundleError(message, data = null) {
  if (data == null) return console.error(`[BundleService] ${message}`);
  console.error(`[BundleService] ${message}`, data);
}

function normalizeUsername(username = "") {
  return String(username || "").trim().toLowerCase();
}

function normalizeBundleId(bundleId = "") {
  return String(bundleId || "").trim();
}

function normalizeRequestKey(requestKey = null) {
  const normalized = String(requestKey || "").trim();
  return normalized || null;
}

function normalizeWriteOptions(options = null) {
  const source = options && typeof options === "object" ? options : {};
  return {
    requestKey: normalizeRequestKey(source.requestKey),
    rejectStaleRequest: source.rejectStaleRequest === true,
    expectedUpdatedAt: source.expectedUpdatedAt || null,
  };
}

function getLineageRequestKey(bundle = null) {
  return normalizeRequestKey(bundle?.lineage?.activeRequestKey || null);
}

function isBundleWriteStale(bundle = null, requestKey = null) {
  const safeRequestKey = normalizeRequestKey(requestKey);
  if (!bundle || !safeRequestKey) return false;
  const lineageRequestKey = getLineageRequestKey(bundle);
  if (!lineageRequestKey) return false;
  return lineageRequestKey !== safeRequestKey;
}

function normalizeMetrics(metricsRequested = []) {
  if (!Array.isArray(metricsRequested)) return [];
  const seen = new Set();
  metricsRequested.forEach((metric) => {
    const normalized = String(metric || "").trim().toLowerCase();
    if (normalized) seen.add(normalized);
  });
  return [...seen];
}

function createBundleId() {
  const timestamp = Date.now();
  if (typeof crypto.randomUUID === "function") {
    return `bundle_${timestamp}_${crypto.randomUUID().slice(0, 8)}`;
  }
  return `bundle_${timestamp}_${crypto.randomBytes(4).toString("hex")}`;
}

function sanitizePlannerOutput(plannerOutput) {
  if (!plannerOutput || typeof plannerOutput !== "object") return {};
  return plannerOutput;
}

function toStoredPlannerResult(plannerResult = {}) {
  return {
    mode: String(plannerResult?.mode || "new_analysis"),
    metrics_needed: normalizeMetrics(plannerResult?.metricsNeeded || plannerResult?.metrics_needed || []),
    time_scope: String(plannerResult?.timeScope || plannerResult?.time_scope || "last_7_days"),
    analysis_goal: String(plannerResult?.analysisGoal || plannerResult?.analysis_goal || ""),
    candidate_stage_types: Array.isArray(plannerResult?.candidateStageTypes)
      ? plannerResult.candidateStageTypes
      : Array.isArray(plannerResult?.candidate_stage_types)
        ? plannerResult.candidate_stage_types
        : [],
    raw: plannerResult?.rawPlannerOutput || plannerResult?.raw || null,
    planner_version: String(plannerResult?.plannerVersion || plannerResult?.planner_version || "phase3"),
    planner_meta: plannerResult?.plannerMeta || plannerResult?.planner_meta || {},
    updated_at: new Date().toISOString(),
  };
}

function logBundleTransition({ fromStatus = null, toStatus = null, bundleId = null, reason = "" } = {}) {
  bundleLog("bundle transition", {
    bundleId,
    fromStatus: fromStatus || null,
    toStatus: toStatus || null,
    reason: reason || "",
    at: new Date().toISOString(),
  });
}

async function createBundle({
  username,
  question,
  displayLabel = "",
  plannerOutput,
  metricsRequested,
  parentBundleId = null,
  status = "active",
  requestKey = null,
  requestSource = "internal",
} = {}) {
  const normalizedUsername = normalizeUsername(username);
  if (!normalizedUsername) {
    throw new Error("createBundle requires a username");
  }

  const nextStatus = VALID_STATUSES.includes(String(status || "").toLowerCase())
    ? String(status).toLowerCase()
    : "active";
  const bundleId = createBundleId();

  const safeRequestKey = normalizeRequestKey(requestKey);
  const safeRequestSource = String(requestSource || "internal").trim().toLowerCase() || "internal";

  const doc = await QnaBundle.create({
    bundleId,
    username: normalizedUsername,
    status: nextStatus,
    question: String(question || "").trim(),
    displayLabel: String(displayLabel || "").trim(),
    plannerOutput: sanitizePlannerOutput(plannerOutput ?? {}),
    metricsRequested: normalizeMetrics(metricsRequested),
    parentBundleId: parentBundleId ? String(parentBundleId) : null,
    rawFitbitCache: {},
    normalizedTable: [],
    stages: [],
    currentStageIndex: 0,
    executorResponseId: null,
    completedAt: null,
    archivedAt: null,
    releasedAt: null,
    lineage: parentBundleId
      ? {
          rootBundleId: String(parentBundleId),
          parentBundleId: String(parentBundleId),
          createdAt: new Date().toISOString(),
          activeRequestKey: safeRequestKey,
          requestSource: safeRequestSource,
        }
      : {
          rootBundleId: bundleId,
          parentBundleId: null,
          createdAt: new Date().toISOString(),
          activeRequestKey: safeRequestKey,
          requestSource: safeRequestSource,
        },
  });

  bundleLog("bundle created", {
    bundleId: doc.bundleId,
    username: doc.username,
    status: doc.status,
    parentBundleId: doc.parentBundleId || null,
    metricsRequested: doc.metricsRequested,
  });

  return doc;
}

async function getBundleById(bundleId) {
  const normalizedBundleId = normalizeBundleId(bundleId);
  if (!normalizedBundleId) return null;

  const doc = await QnaBundle.findOne({ bundleId: normalizedBundleId });
  bundleLog("bundle lookup by id", {
    bundleId: normalizedBundleId,
    found: Boolean(doc),
  });
  return doc;
}

async function ensureWriteAllowed(bundleId, options = null) {
  const normalizedBundleId = normalizeBundleId(bundleId);
  if (!normalizedBundleId) return { ok: false, bundle: null, reason: "missing_bundle_id" };

  const writeOptions = normalizeWriteOptions(options);
  const existing = await getBundleById(normalizedBundleId);
  if (!existing) return { ok: false, bundle: null, reason: "bundle_not_found" };

  if (writeOptions.expectedUpdatedAt) {
    const expectedTs = Number(new Date(writeOptions.expectedUpdatedAt));
    const actualTs = Number(new Date(existing.updatedAt || 0));
    if (Number.isFinite(expectedTs) && Number.isFinite(actualTs) && expectedTs !== actualTs) {
      return { ok: false, bundle: existing, reason: "updated_at_mismatch" };
    }
  }

  if (writeOptions.rejectStaleRequest && isBundleWriteStale(existing, writeOptions.requestKey)) {
    return {
      ok: false,
      bundle: existing,
      reason: "stale_request_rejected",
      requestKey: writeOptions.requestKey,
      activeRequestKey: getLineageRequestKey(existing),
    };
  }

  return {
    ok: true,
    bundle: existing,
    requestKey: writeOptions.requestKey || null,
  };
}

async function loadActiveBundleForUser(username) {
  const normalizedUsername = normalizeUsername(username);
  if (!normalizedUsername) return null;

  const doc = await QnaBundle.findOne({
    username: normalizedUsername,
    status: { $in: ACTIVE_LOOKUP_STATUSES },
  }).sort({ updatedAt: -1 });

  bundleLog("active bundle lookup", {
    username: normalizedUsername,
    statuses: ACTIVE_LOOKUP_STATUSES,
    found: Boolean(doc),
    bundleId: doc?.bundleId || null,
  });

  return doc;
}

async function setBundleRequestOwnership(bundleId, requestKey, source = "internal") {
  const normalizedBundleId = normalizeBundleId(bundleId);
  const safeRequestKey = normalizeRequestKey(requestKey);
  if (!normalizedBundleId || !safeRequestKey) return null;

  const existing = await getBundleById(normalizedBundleId);
  if (!existing) return null;

  const lineage = {
    ...(existing?.lineage || {}),
    activeRequestKey: safeRequestKey,
    requestOwnershipUpdatedAt: new Date().toISOString(),
    requestSource: String(source || "internal").trim().toLowerCase() || "internal",
  };

  return saveBundlePatch(normalizedBundleId, { lineage });
}

async function saveBundlePatch(bundleId, patch = {}, options = null) {
  const normalizedBundleId = normalizeBundleId(bundleId);
  if (!normalizedBundleId) throw new Error("saveBundlePatch requires bundleId");
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("saveBundlePatch requires a plain object patch");
  }

  const writeGuard = await ensureWriteAllowed(normalizedBundleId, options);
  if (!writeGuard.ok) {
    bundleWarn("bundle patch rejected", {
      bundleId: normalizedBundleId,
      reason: writeGuard.reason,
      requestKey: writeGuard.requestKey || normalizeWriteOptions(options).requestKey || null,
      activeRequestKey: writeGuard.activeRequestKey || null,
    });
    return null;
  }

  const nextPatch = { ...patch };
  delete nextPatch._id;
  delete nextPatch.bundleId;
  delete nextPatch.createdAt;

  const updated = await QnaBundle.findOneAndUpdate(
    { bundleId: normalizedBundleId },
    {
      $set: {
        ...nextPatch,
        updatedAt: new Date(),
      },
    },
    { new: true }
  );

  if (!updated) {
    bundleWarn("save patch target not found", { bundleId: normalizedBundleId });
    return null;
  }

  bundleLog("bundle patched", {
    bundleId: normalizedBundleId,
    patchKeys: Object.keys(nextPatch),
  });
  return updated;
}

async function setBundleStatus(bundleId, status, extraPatch = {}, reason = "", options = null) {
  const normalizedStatus = String(status || "").trim().toLowerCase();
  if (!VALID_STATUSES.includes(normalizedStatus)) {
    throw new Error(`Invalid bundle status: ${status}`);
  }

  const existing = await getBundleById(bundleId);
  if (!existing) return null;

  const patch = {
    ...extraPatch,
    status: normalizedStatus,
    archivedAt: normalizedStatus === "archived"
      ? (extraPatch?.archivedAt || new Date())
      : extraPatch?.archivedAt === null
        ? null
        : existing.archivedAt || null,
    releasedAt: normalizedStatus === "released"
      ? (extraPatch?.releasedAt || new Date())
      : extraPatch?.releasedAt === null
        ? null
        : existing.releasedAt || null,
  };
  if (normalizedStatus === "completed" && !patch.completedAt) {
    patch.completedAt = new Date();
  } else if (normalizedStatus !== "completed" && extraPatch?.completedAt === null) {
    patch.completedAt = null;
  }

  const updated = await saveBundlePatch(bundleId, patch, options);
  if (updated) {
    logBundleTransition({
      bundleId,
      fromStatus: existing.status,
      toStatus: normalizedStatus,
      reason,
    });
  }
  return updated;
}

async function storePlannerResult(bundleId, plannerResult) {
  const storedPlanner = toStoredPlannerResult(plannerResult);
  const updated = await saveBundlePatch(bundleId, {
    plannerOutput: storedPlanner,
    metricsRequested: normalizeMetrics(storedPlanner.metrics_needed),
  });

  if (updated) {
    bundleLog("planner result stored", {
      bundleId,
      mode: storedPlanner.mode,
      time_scope: storedPlanner.time_scope,
      metricsRequested: updated.metricsRequested,
    });
  }
  return updated;
}

async function appendStage(bundleId, stage, options = null) {
  const normalizedBundleId = normalizeBundleId(bundleId);
  if (!normalizedBundleId) throw new Error("appendStage requires bundleId");

  const writeGuard = await ensureWriteAllowed(normalizedBundleId, options);
  if (!writeGuard.ok || !writeGuard.bundle) {
    bundleWarn("append stage rejected", {
      bundleId: normalizedBundleId,
      reason: writeGuard.reason,
      requestKey: writeGuard.requestKey || normalizeWriteOptions(options).requestKey || null,
    });
    return null;
  }
  const existing = writeGuard.bundle;

  const nextStage = stage && typeof stage === "object" ? { ...stage } : {};
  const nextIndex = Number.isFinite(Number(nextStage.stageIndex))
    ? Math.max(0, Number(nextStage.stageIndex))
    : (Array.isArray(existing.stages) ? existing.stages.length : 0);
  nextStage.stageIndex = nextIndex;

  const stages = Array.isArray(existing.stages) ? existing.stages.slice() : [];
  const replaceIndex = stages.findIndex((item) => Number(item?.stageIndex) === nextIndex);
  if (replaceIndex >= 0) stages[replaceIndex] = nextStage;
  else stages.push(nextStage);
  stages.sort((a, b) => Number(a?.stageIndex || 0) - Number(b?.stageIndex || 0));

  const updated = await QnaBundle.findOneAndUpdate(
    { bundleId: normalizedBundleId },
    {
      $set: {
        stages,
        updatedAt: new Date(),
      },
    },
    { new: true }
  );

  if (!updated) {
    bundleWarn("append stage target not found", { bundleId: normalizedBundleId });
    return null;
  }

  bundleLog("stage appended", {
    bundleId: normalizedBundleId,
    stageCount: Array.isArray(updated.stages) ? updated.stages.length : 0,
  });
  return updated;
}

async function setCurrentStageIndex(bundleId, index, options = null) {
  const normalizedBundleId = normalizeBundleId(bundleId);
  if (!normalizedBundleId) throw new Error("setCurrentStageIndex requires bundleId");

  const writeGuard = await ensureWriteAllowed(normalizedBundleId, options);
  if (!writeGuard.ok) {
    bundleWarn("set current stage rejected", {
      bundleId: normalizedBundleId,
      reason: writeGuard.reason,
      requestKey: writeGuard.requestKey || normalizeWriteOptions(options).requestKey || null,
    });
    return null;
  }

  const safeIndex = Math.max(0, Number.isFinite(Number(index)) ? Number(index) : 0);
  const updated = await QnaBundle.findOneAndUpdate(
    { bundleId: normalizedBundleId },
    { $set: { currentStageIndex: safeIndex, updatedAt: new Date() } },
    { new: true }
  );

  if (!updated) {
    bundleWarn("set current stage target not found", { bundleId: normalizedBundleId });
    return null;
  }

  bundleLog("current stage index updated", {
    bundleId: normalizedBundleId,
    currentStageIndex: safeIndex,
  });
  return updated;
}

async function markBundleComplete(bundleId, options = null) {
  const normalizedBundleId = normalizeBundleId(bundleId);
  if (!normalizedBundleId) throw new Error("markBundleComplete requires bundleId");
  return setBundleStatus(normalizedBundleId, "completed", {}, "mark_bundle_complete", options);
}

async function releaseBundle(bundleId, reason = "release_bundle", options = null) {
  const normalizedBundleId = normalizeBundleId(bundleId);
  if (!normalizedBundleId) throw new Error("releaseBundle requires bundleId");
  return setBundleStatus(
    normalizedBundleId,
    "released",
    {
      releasedAt: new Date(),
    },
    reason,
    options
  );
}

async function touchBundle(bundleId, options = null) {
  const normalizedBundleId = normalizeBundleId(bundleId);
  if (!normalizedBundleId) throw new Error("touchBundle requires bundleId");

  const writeGuard = await ensureWriteAllowed(normalizedBundleId, options);
  if (!writeGuard.ok) {
    bundleWarn("touch rejected", {
      bundleId: normalizedBundleId,
      reason: writeGuard.reason,
      requestKey: writeGuard.requestKey || normalizeWriteOptions(options).requestKey || null,
    });
    return null;
  }

  const updated = await QnaBundle.findOneAndUpdate(
    { bundleId: normalizedBundleId },
    { $set: { updatedAt: new Date() } },
    { new: true }
  );

  if (!updated) {
    bundleWarn("touch target not found", { bundleId: normalizedBundleId });
    return null;
  }

  bundleLog("bundle touched", { bundleId: normalizedBundleId });
  return updated;
}

async function createBranchBundle({
  sourceBundle,
  username,
  question,
  displayLabel = "",
  plannerOutput,
  metricsRequested,
  requestKey = null,
  requestSource = "followup",
} = {}) {
  if (!sourceBundle?.bundleId) {
    throw new Error("createBranchBundle requires sourceBundle");
  }

  const branchDoc = await createBundle({
    username: username || sourceBundle.username,
    question,
    displayLabel,
    plannerOutput: {
      ...(sanitizePlannerOutput(plannerOutput) || {}),
      branch: {
        fromBundleId: sourceBundle.bundleId,
        createdAt: new Date().toISOString(),
      },
    },
    metricsRequested: normalizeMetrics(metricsRequested),
    parentBundleId: sourceBundle.bundleId,
    status: "active",
    requestKey,
    requestSource,
  });

  await saveBundlePatch(branchDoc.bundleId, {
    lineage: {
      rootBundleId: sourceBundle?.lineage?.rootBundleId || sourceBundle.bundleId,
      parentBundleId: sourceBundle.bundleId,
      branchCreatedAt: new Date().toISOString(),
      branchDepth: Math.max(1, Number(sourceBundle?.lineage?.branchDepth || 0) + 1),
      activeRequestKey: normalizeRequestKey(requestKey),
      requestSource: String(requestSource || "followup").trim().toLowerCase(),
    },
  });

  bundleLog("branch bundle created", {
    sourceBundleId: sourceBundle.bundleId,
    branchBundleId: branchDoc.bundleId,
  });
  return branchDoc;
}

async function archiveOlderActiveBundles(username, keepBundleId = null, reason = "new_analysis_archive_policy") {
  const normalizedUsername = normalizeUsername(username);
  if (!normalizedUsername) return { archivedCount: 0, archivedBundleIds: [] };

  const keepId = normalizeBundleId(keepBundleId);
  const candidates = await QnaBundle.find({
    username: normalizedUsername,
    status: { $in: ACTIVE_LOOKUP_STATUSES },
    ...(keepId ? { bundleId: { $ne: keepId } } : {}),
  }).sort({ updatedAt: -1 });

  if (!candidates.length) {
    bundleLog("archive policy found no older active bundles", {
      username: normalizedUsername,
      keepBundleId: keepId || null,
    });
    return { archivedCount: 0, archivedBundleIds: [] };
  }

  const archivedBundleIds = [];
  for (const doc of candidates) {
    const archived = await setBundleStatus(
      doc.bundleId,
      "archived",
      {
        archivedAt: new Date(),
        lineage: {
          ...(doc?.lineage || {}),
          archiveReason: reason,
          archivedFromStatus: doc.status || null,
        },
      },
      reason
    );
    if (archived) archivedBundleIds.push(doc.bundleId);
  }

  bundleLog("archive policy applied", {
    username: normalizedUsername,
    keepBundleId: keepId || null,
    archivedCount: archivedBundleIds.length,
    archivedBundleIds,
  });

  return {
    archivedCount: archivedBundleIds.length,
    archivedBundleIds,
  };
}

async function releaseOlderActiveBundles(username, keepBundleId = null, reason = "new_analysis_release_policy") {
  const normalizedUsername = normalizeUsername(username);
  if (!normalizedUsername) return { releasedCount: 0, releasedBundleIds: [] };

  const keepId = normalizeBundleId(keepBundleId);
  const candidates = await QnaBundle.find({
    username: normalizedUsername,
    status: { $in: ACTIVE_LOOKUP_STATUSES },
    ...(keepId ? { bundleId: { $ne: keepId } } : {}),
  }).sort({ updatedAt: -1 });

  if (!candidates.length) {
    bundleLog("release policy found no older active bundles", {
      username: normalizedUsername,
      keepBundleId: keepId || null,
    });
    return { releasedCount: 0, releasedBundleIds: [] };
  }

  const releasedBundleIds = [];
  for (const doc of candidates) {
    const released = await releaseBundle(doc.bundleId, reason);
    if (released) releasedBundleIds.push(doc.bundleId);
  }

  bundleLog("release policy applied", {
    username: normalizedUsername,
    keepBundleId: keepId || null,
    releasedCount: releasedBundleIds.length,
    releasedBundleIds,
  });

  return {
    releasedCount: releasedBundleIds.length,
    releasedBundleIds,
  };
}

async function saveExecutorState(
  bundleId,
  { executorResponseId = null, currentStageIndex = null } = {},
  options = null
) {
  const normalizedBundleId = normalizeBundleId(bundleId);
  if (!normalizedBundleId) throw new Error("saveExecutorState requires bundleId");

  const patch = {};
  if (executorResponseId !== undefined) {
    patch.executorResponseId = executorResponseId ? String(executorResponseId) : null;
  }
  if (currentStageIndex !== undefined && currentStageIndex !== null) {
    patch.currentStageIndex = Math.max(0, Number(currentStageIndex) || 0);
  }
  if (!Object.keys(patch).length) return getBundleById(normalizedBundleId);

  const updated = await saveBundlePatch(normalizedBundleId, patch, options);
  if (updated) {
    bundleLog("executor state saved", {
      bundleId: normalizedBundleId,
      executorResponseId: patch.executorResponseId || null,
      currentStageIndex: patch.currentStageIndex,
    });
  }
  return updated;
}

function resolveBundleStatusForStage(stageRecord = null, { completeWhenDone = false } = {}) {
  const moreAvailable = Boolean(stageRecord?.moreAvailable);
  if (moreAvailable) return "partial";
  return completeWhenDone ? "completed" : "ready";
}

/**
 * Phase 6 helper:
 * appends/updates one stage and persists executor chain pointer in one call.
 */
async function appendOrUpdateStageAndState({
  bundleId,
  stageRecord,
  executorResponseId = undefined,
  completeWhenDone = false,
  statusReason = "executor_stage_persisted",
  requestKey = null,
  rejectStaleRequest = false,
} = {}) {
  const normalizedBundleId = normalizeBundleId(bundleId);
  if (!normalizedBundleId) throw new Error("appendOrUpdateStageAndState requires bundleId");
  if (!stageRecord || typeof stageRecord !== "object") {
    throw new Error("appendOrUpdateStageAndState requires stageRecord");
  }

  const writeOptions = {
    requestKey,
    rejectStaleRequest: rejectStaleRequest === true,
  };

  const appended = await appendStage(normalizedBundleId, stageRecord, writeOptions);
  if (!appended) return null;

  const nextExecutorResponseId = executorResponseId !== undefined
    ? (executorResponseId ? String(executorResponseId) : null)
    : (appended.executorResponseId || null);

  await saveExecutorState(normalizedBundleId, {
    executorResponseId: nextExecutorResponseId,
    currentStageIndex: Number(stageRecord.stageIndex || 0),
  }, writeOptions);

  const nextStatus = resolveBundleStatusForStage(stageRecord, { completeWhenDone });
  await setBundleStatus(normalizedBundleId, nextStatus, {}, statusReason, writeOptions);

  return getBundleById(normalizedBundleId);
}

module.exports = {
  ACTIVE_LOOKUP_STATUSES,
  VALID_STATUSES,
  archiveOlderActiveBundles,
  createBundle,
  createBranchBundle,
  ensureWriteAllowed,
  getBundleById,
  isBundleWriteStale,
  loadActiveBundleForUser,
  setBundleRequestOwnership,
  releaseOlderActiveBundles,
  saveBundlePatch,
  saveExecutorState,
  appendOrUpdateStageAndState,
  resolveBundleStatusForStage,
  setBundleStatus,
  storePlannerResult,
  toStoredPlannerResult,
  appendStage,
  setCurrentStageIndex,
  markBundleComplete,
  releaseBundle,
  touchBundle,
};
