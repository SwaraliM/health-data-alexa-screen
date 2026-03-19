/**
 * backend/services/qna/sessionService.js
 *
 * Phase 7 lightweight in-memory session helpers.
 * This complements (does not replace) router-level polling/session maps by
 * storing orchestrator-centric state: active bundle id, stage index, request keys,
 * and request ownership safety for overlapping multi-device requests.
 */

const SESSION_DEBUG = process.env.QNA_SESSION_DEBUG !== "false";
const qnaSessionState = new Map();
const MAX_TRACKED_ACTIVE_REQUESTS = 24;
const MAX_COMPLETED_REQUESTS = 24;

function sessionLog(message, data = null) {
  if (!SESSION_DEBUG) return;
  if (data == null) return console.log(`[SessionService] ${message}`);
  console.log(`[SessionService] ${message}`, data);
}

function normalizeUsername(username = "") {
  return String(username || "").trim().toLowerCase();
}

function ensureSession(username) {
  const userKey = normalizeUsername(username);
  if (!userKey) return null;

  if (!qnaSessionState.has(userKey)) {
    qnaSessionState.set(userKey, {
      username: userKey,
      activeBundleId: null,
      currentStageIndex: 0,
      requestedStageIndex: null,
      latestRequestKey: null,
      activeRequestKey: null,
      activeRequests: {},
      completedRequests: [],
      latestRequestByBundle: {},
      lastSource: null,
      lastDeliveredStageIndex: -1,
      updatedAt: Date.now(),
    });
  }
  return qnaSessionState.get(userKey);
}

function touchSession(username) {
  const session = ensureSession(username);
  if (!session) return null;
  session.updatedAt = Date.now();
  return session;
}

function getSessionState(username) {
  const userKey = normalizeUsername(username);
  if (!userKey) return null;
  return qnaSessionState.get(userKey) || null;
}

function getActiveSessionState(username) {
  const session = getSessionState(username);
  if (!session) return null;
  return {
    username: session.username,
    activeBundleId: session.activeBundleId,
    currentStageIndex: session.currentStageIndex,
    requestedStageIndex: session.requestedStageIndex,
    latestRequestKey: session.latestRequestKey,
    activeRequestKey: session.activeRequestKey || session.latestRequestKey || null,
    activeRequestCount: Object.keys(session.activeRequests || {}).length,
    latestRequestByBundle: {
      ...(session.latestRequestByBundle || {}),
    },
    lastSource: session.lastSource || null,
    lastDeliveredStageIndex: session.lastDeliveredStageIndex ?? -1,
    updatedAt: session.updatedAt,
  };
}

function normalizeRequestKey(requestKey = null) {
  const normalized = String(requestKey || "").trim();
  return normalized || null;
}

function makeRequestKey() {
  return `req_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

function pruneSessionRequests(session) {
  const activeKeys = Object.keys(session.activeRequests || {});
  if (activeKeys.length > MAX_TRACKED_ACTIVE_REQUESTS) {
    const sorted = activeKeys
      .map((key) => session.activeRequests[key])
      .filter(Boolean)
      .sort((a, b) => Number(a.startedAt || 0) - Number(b.startedAt || 0));
    const removeCount = activeKeys.length - MAX_TRACKED_ACTIVE_REQUESTS;
    sorted.slice(0, removeCount).forEach((record) => {
      if (record?.requestKey) delete session.activeRequests[record.requestKey];
    });
  }

  if (Array.isArray(session.completedRequests) && session.completedRequests.length > MAX_COMPLETED_REQUESTS) {
    session.completedRequests = session.completedRequests.slice(-MAX_COMPLETED_REQUESTS);
  }
}

function beginRequest({
  username,
  bundleId = null,
  source = "internal",
  requestKey = null,
} = {}) {
  const session = ensureSession(username);
  if (!session) {
    return {
      ok: false,
      requestKey: null,
      concurrentDetected: false,
      activeRequestCount: 0,
    };
  }

  const safeRequestKey = normalizeRequestKey(requestKey) || makeRequestKey();
  const safeBundleId = bundleId ? String(bundleId) : null;
  const safeSource = String(source || "internal").trim().toLowerCase() || "internal";
  const activeRequestCount = Object.keys(session.activeRequests || {}).length;
  const concurrentDetected = activeRequestCount > 0 && !session.activeRequests[safeRequestKey];

  session.activeRequests[safeRequestKey] = {
    requestKey: safeRequestKey,
    bundleId: safeBundleId,
    source: safeSource,
    startedAt: Date.now(),
    status: "active",
  };

  if (safeBundleId) {
    session.latestRequestByBundle[safeBundleId] = safeRequestKey;
    session.activeBundleId = safeBundleId;
  }

  session.activeRequestKey = safeRequestKey;
  session.latestRequestKey = safeRequestKey;
  session.lastSource = safeSource;

  pruneSessionRequests(session);
  touchSession(username);

  sessionLog("request begun", {
    username: session.username,
    requestKey: safeRequestKey,
    bundleId: safeBundleId,
    source: safeSource,
    concurrentDetected,
    activeRequestCount: Object.keys(session.activeRequests || {}).length,
  });

  return {
    ok: true,
    requestKey: safeRequestKey,
    concurrentDetected,
    activeRequestCount: Object.keys(session.activeRequests || {}).length,
  };
}

function setActiveBundleId(username, bundleId) {
  const session = ensureSession(username);
  if (!session) return null;
  const safeBundleId = bundleId ? String(bundleId) : null;
  session.activeBundleId = safeBundleId;
  if (safeBundleId && session.latestRequestKey) {
    session.latestRequestByBundle[safeBundleId] = session.latestRequestKey;
  }
  touchSession(username);
  sessionLog("active bundle set", {
    username: session.username,
    activeBundleId: session.activeBundleId,
  });
  return session;
}

function setActiveBundleForUser(username, bundleId) {
  return setActiveBundleId(username, bundleId);
}

function setCurrentStageIndex(username, stageIndex) {
  const session = ensureSession(username);
  if (!session) return null;
  session.currentStageIndex = Math.max(0, Number(stageIndex) || 0);
  touchSession(username);
  return session;
}

function setRequestedStageIndex(username, stageIndex) {
  const session = ensureSession(username);
  if (!session) return null;
  if (stageIndex == null || stageIndex === "") {
    session.requestedStageIndex = null;
  } else {
    session.requestedStageIndex = Math.max(0, Number(stageIndex) || 0);
  }
  touchSession(username);
  return session;
}

function applyStageReplayState(username, { activeStageIndex = null, requestedStageIndex = null } = {}) {
  const session = ensureSession(username);
  if (!session) return null;

  if (activeStageIndex != null && activeStageIndex !== "") {
    session.currentStageIndex = Math.max(0, Number(activeStageIndex) || 0);
  }
  if (requestedStageIndex == null || requestedStageIndex === "") {
    session.requestedStageIndex = null;
  } else {
    session.requestedStageIndex = Math.max(0, Number(requestedStageIndex) || 0);
  }
  touchSession(username);
  return session;
}

function getActiveBundleId(username) {
  return getSessionState(username)?.activeBundleId || null;
}

function setLatestRequestKey(username, requestKey) {
  const session = ensureSession(username);
  if (!session) return null;
  const safeRequestKey = normalizeRequestKey(requestKey);
  session.latestRequestKey = safeRequestKey;
  session.activeRequestKey = safeRequestKey;
  if (safeRequestKey && !session.activeRequests[safeRequestKey]) {
    session.activeRequests[safeRequestKey] = {
      requestKey: safeRequestKey,
      bundleId: session.activeBundleId || null,
      source: session.lastSource || "internal",
      startedAt: Date.now(),
      status: "active",
    };
  }
  if (session.activeBundleId && safeRequestKey) {
    session.latestRequestByBundle[session.activeBundleId] = safeRequestKey;
  }
  pruneSessionRequests(session);
  touchSession(username);
  return session;
}

function setRequestBundleOwnership({ username, requestKey, bundleId } = {}) {
  const session = ensureSession(username);
  if (!session) return null;
  const safeRequestKey = normalizeRequestKey(requestKey);
  const safeBundleId = bundleId ? String(bundleId) : null;
  if (!safeRequestKey || !safeBundleId) return session;

  const existing = session.activeRequests[safeRequestKey] || {
    requestKey: safeRequestKey,
    startedAt: Date.now(),
    source: session.lastSource || "internal",
    status: "active",
  };
  existing.bundleId = safeBundleId;
  session.activeRequests[safeRequestKey] = existing;
  session.latestRequestByBundle[safeBundleId] = safeRequestKey;
  session.activeBundleId = safeBundleId;
  touchSession(username);
  return session;
}

function isCurrentRequest({ username, requestKey, bundleId = null } = {}) {
  const session = getSessionState(username);
  const safeRequestKey = normalizeRequestKey(requestKey);
  if (!session || !safeRequestKey) return false;

  if (session.latestRequestKey && session.latestRequestKey !== safeRequestKey) {
    return false;
  }

  const safeBundleId = bundleId ? String(bundleId) : null;
  if (!safeBundleId) return true;

  const bundleOwnerKey = session.latestRequestByBundle?.[safeBundleId] || null;
  if (!bundleOwnerKey) return true;
  return bundleOwnerKey === safeRequestKey;
}

function isStaleRequest(username, requestKey) {
  const session = getSessionState(username);
  const safeRequestKey = normalizeRequestKey(requestKey);
  if (!session || !session.latestRequestKey || !safeRequestKey) return false;
  return !isCurrentRequest({
    username,
    requestKey: safeRequestKey,
    bundleId: session.activeBundleId || null,
  });
}

function endRequest({ username, requestKey, status = "completed", bundleId = null } = {}) {
  const session = ensureSession(username);
  if (!session) return null;
  const safeRequestKey = normalizeRequestKey(requestKey);
  const safeBundleId = bundleId ? String(bundleId) : null;
  if (!safeRequestKey) return session;

  const existing = session.activeRequests[safeRequestKey];
  if (existing) {
    delete session.activeRequests[safeRequestKey];
    const completed = {
      ...existing,
      status: String(status || "completed"),
      endedAt: Date.now(),
      bundleId: safeBundleId || existing.bundleId || null,
    };
    session.completedRequests.push(completed);
  }

  if (session.activeRequestKey === safeRequestKey) {
    session.activeRequestKey = session.latestRequestKey;
  }

  if (safeBundleId && session.latestRequestByBundle?.[safeBundleId] === safeRequestKey) {
    const replacement = Object.values(session.activeRequests || {})
      .filter((record) => record?.bundleId === safeBundleId)
      .sort((a, b) => Number(b.startedAt || 0) - Number(a.startedAt || 0))[0];
    if (replacement?.requestKey) session.latestRequestByBundle[safeBundleId] = replacement.requestKey;
    else delete session.latestRequestByBundle[safeBundleId];
  }

  pruneSessionRequests(session);
  touchSession(username);
  sessionLog("request ended", {
    username: session.username,
    requestKey: safeRequestKey,
    status,
    bundleId: safeBundleId || existing?.bundleId || null,
    activeRequestCount: Object.keys(session.activeRequests || {}).length,
  });
  return session;
}

function setLastDeliveredStageIndex(username, stageIndex) {
  const session = ensureSession(username);
  if (!session) return null;
  session.lastDeliveredStageIndex = Number(stageIndex ?? -1);
  touchSession(username);
  return session;
}

function clearSessionState(username) {
  const userKey = normalizeUsername(username);
  if (!userKey) return false;
  return qnaSessionState.delete(userKey);
}

module.exports = {
  applyStageReplayState,
  beginRequest,
  clearSessionState,
  endRequest,
  getActiveBundleId,
  getActiveSessionState,
  getSessionState,
  isCurrentRequest,
  isStaleRequest,
  setActiveBundleId,
  setActiveBundleForUser,
  setCurrentStageIndex,
  setLastDeliveredStageIndex,
  setLatestRequestKey,
  setRequestBundleOwnership,
  setRequestedStageIndex,
  touchSession,
};
