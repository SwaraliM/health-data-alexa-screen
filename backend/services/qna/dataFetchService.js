/**
 * backend/services/qna/dataFetchService.js
 *
 * Extracted from qnaOrchestrator.js — owns all Fitbit data fetching,
 * metric adaptation, and evidence computation.
 *
 * Single entry point: fetchAndComputeEvidence()
 */

"use strict";

const {
  adaptCaloriesRange,
  adaptDistanceRange,
  adaptElevationRange,
  adaptFloorsRange,
  adaptHrvRange,
  adaptIntradayActivity,
  adaptIntradayHeart,
  adaptRestingHeartRateRange,
  adaptSleepRange,
  adaptStepsRange,
  adaptSleepStagesRange,
  adaptBreathingRateRange,
  adaptSpo2Range,
  adaptAzmRange,
  adaptExerciseSessionsRange,
} = require("../fitbit/endpointAdapters");
const { resolveRequestedMetrics } = require("../fitbit/metricResolver");
const { buildNormalizedTable } = require("../fitbit/normalizeSeries");
const { buildEvidenceBundle } = require("../analytics/evidenceComputer");
const { saveBundlePatch } = require("./bundleService");

const FETCH_DEBUG = process.env.QNA_DATA_FETCH_DEBUG !== "false";
const FETCH_TIMEOUT_MS = Number(process.env.QNA_BUNDLE_FETCH_TIMEOUT_MS || 4800);

const TIME_SCOPE_DAY_CONFIG = {
  today: { days: 1, offset: 0 },
  yesterday: { days: 1, offset: 1 },
  last_night: { days: 1, offset: 1 },
  day_before_yesterday: { days: 1, offset: 2 },
  this_week: { days: 7, offset: 0 },
  last_week: { days: 7, offset: 7 },
  last_3_days: { days: 3, offset: 0 },
  last_7_days: { days: 7, offset: 0 },
  last_14_days: { days: 14, offset: 0 },
  last_30_days: { days: 30, offset: 0 },
};

const SLEEP_STAGE_METRICS = new Set([
  "sleep_deep",
  "sleep_light",
  "sleep_rem",
  "sleep_awake",
  "sleep_efficiency",
]);

// Per-type exercise-session minute metrics — all sourced from ONE exercise-log fetch.
const EXERCISE_SESSION_METRICS = new Set(["walk_minutes", "hiit_minutes"]);

function fetchLog(msg, data = null) {
  if (!FETCH_DEBUG) return;
  if (data == null) return console.log(`[DataFetchService] ${msg}`);
  console.log(`[DataFetchService] ${msg}`, data);
}

function fetchWarn(msg, data = null) {
  if (data == null) return console.warn(`[DataFetchService] ${msg}`);
  console.warn(`[DataFetchService] ${msg}`, data);
}

function sanitizeText(value, max = 220, fallback = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : fallback;
}

function isSingleDayScope(timeScope = "") {
  return ["today", "yesterday", "last_night"].includes(String(timeScope || "").toLowerCase());
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function enumerateDates(startDate, endDate) {
  const out = [];
  let d = new Date(`${startDate}T12:00:00`);
  const end = new Date(`${endDate}T12:00:00`);
  while (d <= end) {
    out.push(formatDate(d));
    d = new Date(d.getTime() + 86400000);
  }
  return out;
}

function computeDateWindow(timeScope = "last_7_days") {
  const key = String(timeScope || "last_7_days").toLowerCase();
  const config = TIME_SCOPE_DAY_CONFIG[key] || TIME_SCOPE_DAY_CONFIG.last_7_days;
  const now = new Date();
  const end = new Date(now);
  end.setDate(now.getDate() - Number(config.offset || 0));
  const start = new Date(end);
  start.setDate(end.getDate() - (Math.max(1, Number(config.days || 7)) - 1));
  return {
    timeScope: key,
    startDate: formatDate(start),
    endDate: formatDate(end),
  };
}

function normalizeInternalApiBase(candidate = "") {
  const value = String(candidate || "").trim();
  if (!value) return "";
  return value.replace(/\/+$/, "").replace(/\/api$/, "");
}

function resolveInternalApiBaseUrl() {
  const configuredBase = [
    process.env.REACT_APP_FETCH_DATA_URL,
    process.env.QNA_INTERNAL_API_URL,
    process.env.INTERNAL_API_URL,
    process.env.BACKEND_URL,
    process.env.API_URL,
    process.env.RENDER_EXTERNAL_URL,
    process.env.PUBLIC_BASE_URL,
  ]
    .map((value) => normalizeInternalApiBase(value))
    .find(Boolean);

  if (configuredBase) return configuredBase;

  const port = Number.parseInt(process.env.PORT, 10);
  const safePort = Number.isFinite(port) && port > 0 ? port : 5001;
  return `http://127.0.0.1:${safePort}`;
}

function buildFitbitInternalUrl({ username, metricKey, startDate, endDate, timeScope = "last_7_days" }) {
  const base = resolveInternalApiBaseUrl();
  const user = String(username || "").toLowerCase();

  if (["sleep_minutes", "sleep_efficiency", "wake_minutes", "sleep_deep", "sleep_light", "sleep_rem", "sleep_awake"].includes(metricKey)) {
    if (isSingleDayScope(timeScope)) return `${base}/api/fitbit/${user}/sleep/single-day/date/${endDate}`;
    return `${base}/api/fitbit/${user}/sleep/range/date/${startDate}/${endDate}`;
  }
  if (metricKey === "breathing_rate") {
    if (isSingleDayScope(timeScope)) return `${base}/api/fitbit/${user}/br/single-day/date/${endDate}`;
    return `${base}/api/fitbit/${user}/br/range/date/${startDate}/${endDate}`;
  }
  if (metricKey === "spo2") {
    if (isSingleDayScope(timeScope)) return `${base}/api/fitbit/${user}/spo2/single-day/date/${endDate}`;
    return `${base}/api/fitbit/${user}/spo2/range/date/${startDate}/${endDate}`;
  }
  if (metricKey === "weight") {
    if (isSingleDayScope(timeScope)) return `${base}/api/fitbit/${user}/body/log/weight/date/${endDate}`;
    return `${base}/api/fitbit/${user}/body/log/weight/date/${startDate}/${endDate}`;
  }
  if (metricKey === "body_fat") {
    if (isSingleDayScope(timeScope)) return `${base}/api/fitbit/${user}/body/log/fat/date/${endDate}`;
    return `${base}/api/fitbit/${user}/body/log/fat/date/${startDate}/${endDate}`;
  }
  if (metricKey === "resting_hr") return `${base}/api/fitbit/${user}/heart/range/date/${startDate}/${endDate}`;
  if (metricKey === "heart_intraday") return `${base}/api/fitbit/${user}/heart/intraday/${startDate}`;
  if (metricKey === "steps_intraday") return `${base}/api/fitbit/${user}/activities/intraday/steps/${startDate}`;
  if (metricKey === "calories_intraday") return `${base}/api/fitbit/${user}/activities/intraday/calories/${startDate}`;
  if (metricKey === "distance_intraday") return `${base}/api/fitbit/${user}/activities/intraday/distance/${startDate}`;
  if (metricKey === "floors_intraday") return `${base}/api/fitbit/${user}/activities/intraday/floors/${startDate}`;
  if (metricKey === "calories") return `${base}/api/fitbit/${user}/activities/range/calories/date/${startDate}/${endDate}`;
  if (metricKey === "distance") return `${base}/api/fitbit/${user}/activities/range/distance/date/${startDate}/${endDate}`;
  if (metricKey === "floors") return `${base}/api/fitbit/${user}/activities/range/floors/date/${startDate}/${endDate}`;
  if (metricKey === "elevation") return `${base}/api/fitbit/${user}/activities/range/elevation/date/${startDate}/${endDate}`;
  if (metricKey === "hrv") return `${base}/api/fitbit/${user}/hrv/range/date/${startDate}/${endDate}`;
  if (metricKey === "active_zone_minutes") return `${base}/api/fitbit/${user}/activities/azm/range/date/${startDate}/${endDate}`;
  if (EXERCISE_SESSION_METRICS.has(metricKey)) return `${base}/api/fitbit/${user}/activities/log/range/date/${startDate}/${endDate}`;
  return `${base}/api/fitbit/${user}/activities/range/steps/date/${startDate}/${endDate}`;
}

function mapMetricPayload(metric, payload) {
  const metricKey = String(metric || "").toLowerCase();
  if (metricKey === "steps") return adaptStepsRange(payload);
  if (metricKey === "calories") return adaptCaloriesRange(payload);
  if (metricKey === "distance") return adaptDistanceRange(payload);
  if (metricKey === "floors") return adaptFloorsRange(payload);
  if (metricKey === "elevation") return adaptElevationRange(payload);
  if (metricKey === "sleep_minutes") return adaptSleepRange(payload);
  if (metricKey === "resting_hr") return adaptRestingHeartRateRange(payload);
  if (metricKey === "hrv") return adaptHrvRange(payload);
  if (metricKey === "heart_intraday") return adaptIntradayHeart(payload);
  if (SLEEP_STAGE_METRICS.has(metricKey)) return adaptSleepStagesRange(payload);
  if (EXERCISE_SESSION_METRICS.has(metricKey)) return adaptExerciseSessionsRange(payload);
  if (metricKey === "active_zone_minutes") return adaptAzmRange(payload);
  if (metricKey === "breathing_rate") return adaptBreathingRateRange(payload);
  if (metricKey === "spo2") return adaptSpo2Range(payload);
  if (metricKey.endsWith("_intraday")) {
    const resource = metricKey.replace(/_intraday$/, "");
    return adaptIntradayActivity(payload, resource);
  }
  return adaptStepsRange(payload);
}

async function fetchJsonWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const ms = Math.max(1200, Number(timeoutMs) || FETCH_TIMEOUT_MS);
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), ms) : null;
  try {
    const response = await fetch(url, { signal: controller?.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}: ${sanitizeText(body, 160, "fetch failed")}`);
    }
    return await response.json();
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Fetch data for multiple sub-analyses, each with its own time window and metrics.
 * Returns a multiWindowData object keyed by sub-analysis ID.
 */
async function fetchMultiWindowData({ bundle, username, subAnalyses, fetchTimeoutMs = null } = {}) {
  if (!Array.isArray(subAnalyses) || !subAnalyses.length) return {};

  const multiWindowData = {};
  const existingCache = bundle?.rawFitbitCache && typeof bundle.rawFitbitCache === "object"
    ? { ...bundle.rawFitbitCache }
    : {};
  const fetchedWindows = new Map();

  for (const sa of subAnalyses) {
    const saId = sa.id || `sa_${Object.keys(multiWindowData).length}`;
    const metrics = resolveRequestedMetrics(sa.metrics_needed || []).slice(0, 8);
    const window = computeDateWindow(sa.time_scope || "last_7_days");
    const metricSeriesMap = {};

    // Sleep stage dedup
    const sleepStageRequested = metrics.filter((m) => SLEEP_STAGE_METRICS.has(m));
    if (sleepStageRequested.length > 0) {
      const sleepCacheKey = `sleep_stages:${window.startDate}:${window.endDate}`;
      if (!fetchedWindows.has(sleepCacheKey)) {
        const sleepUrl = buildFitbitInternalUrl({
          username, metricKey: "sleep_minutes",
          startDate: window.startDate, endDate: window.endDate, timeScope: window.timeScope,
        });
        try {
          const sleepRaw = await fetchJsonWithTimeout(sleepUrl, fetchTimeoutMs || FETCH_TIMEOUT_MS);
          const sleepStagePoints = adaptSleepStagesRange(sleepRaw);
          for (const stageMetric of SLEEP_STAGE_METRICS) {
            const key = `${stageMetric}:${window.startDate}:${window.endDate}`;
            fetchedWindows.set(key, sleepStagePoints);
            existingCache[`${saId}_${stageMetric}`] = {
              metric: stageMetric, timeScope: window.timeScope,
              startDate: window.startDate, endDate: window.endDate,
              fetchedAt: new Date().toISOString(), sourceUrl: sleepUrl,
              raw: sleepRaw, adaptedPoints: sleepStagePoints,
            };
          }
          fetchedWindows.set(sleepCacheKey, sleepStagePoints);
        } catch (error) {
          fetchWarn("sleep stage fetch failed", { saId, message: error?.message || String(error) });
        }
      }
    }

    // Exercise-session dedup: walk_minutes + hiit_minutes come from ONE exercise-log fetch.
    const exerciseRequested = metrics.filter((m) => EXERCISE_SESSION_METRICS.has(m));
    if (exerciseRequested.length > 0) {
      const exCacheKey = `exercise_log:${window.startDate}:${window.endDate}`;
      if (!fetchedWindows.has(exCacheKey)) {
        const exUrl = buildFitbitInternalUrl({
          username, metricKey: "walk_minutes",
          startDate: window.startDate, endDate: window.endDate, timeScope: window.timeScope,
        });
        try {
          const exRaw = await fetchJsonWithTimeout(exUrl, fetchTimeoutMs || FETCH_TIMEOUT_MS);
          const rawExPoints = adaptExerciseSessionsRange(exRaw);
          // Densify: per-type workout minutes are sparse (only logged on session days).
          // A day with no session = 0 minutes of that workout, NOT missing. Emit a point
          // for EVERY date in the window (0 when absent) so the series is full-length and
          // aligns to the date axis — the executor can't drop/compact nulls and misplace bars.
          const valueByKey = new Map();
          for (const p of rawExPoints) valueByKey.set(`${p.metric}|${p.timestamp}`, p.value);
          const windowDates = enumerateDates(window.startDate, window.endDate);
          const exPoints = [];
          for (const exMetric of EXERCISE_SESSION_METRICS) {
            for (const d of windowDates) {
              const v = valueByKey.get(`${exMetric}|${d}`);
              exPoints.push({ timestamp: d, label: d, metric: exMetric, value: v == null ? 0 : v, meta: {} });
            }
          }
          for (const exMetric of EXERCISE_SESSION_METRICS) {
            const key = `${exMetric}:${window.startDate}:${window.endDate}`;
            fetchedWindows.set(key, exPoints);
            existingCache[`${saId}_${exMetric}`] = {
              metric: exMetric, timeScope: window.timeScope,
              startDate: window.startDate, endDate: window.endDate,
              fetchedAt: new Date().toISOString(), sourceUrl: exUrl,
              raw: exRaw, adaptedPoints: exPoints,
            };
          }
          fetchedWindows.set(exCacheKey, exPoints);
        } catch (error) {
          fetchWarn("exercise log fetch failed", { saId, message: error?.message || String(error) });
        }
      }
    }

    for (const metric of metrics) {
      const dedupeKey = `${metric}:${window.startDate}:${window.endDate}`;
      if (fetchedWindows.has(dedupeKey)) {
        metricSeriesMap[metric] = fetchedWindows.get(dedupeKey);
        continue;
      }

      const url = buildFitbitInternalUrl({
        username, metricKey: metric,
        startDate: window.startDate, endDate: window.endDate, timeScope: window.timeScope,
      });
      try {
        const raw = await fetchJsonWithTimeout(url, fetchTimeoutMs || FETCH_TIMEOUT_MS);
        const adaptedPoints = mapMetricPayload(metric, raw);
        metricSeriesMap[metric] = adaptedPoints;
        fetchedWindows.set(dedupeKey, adaptedPoints);
        existingCache[`${saId}_${metric}`] = {
          metric, timeScope: window.timeScope,
          startDate: window.startDate, endDate: window.endDate,
          fetchedAt: new Date().toISOString(), sourceUrl: url,
          raw, adaptedPoints,
        };
      } catch (error) {
        fetchWarn("metric fetch failed", { saId, metric, message: error?.message || String(error) });
        metricSeriesMap[metric] = [];
      }
    }

    multiWindowData[saId] = {
      id: saId,
      label: sa.label || "",
      time_scope: sa.time_scope || "last_7_days",
      analysis_type: sa.analysis_type || "",
      metrics_needed: metrics,
      window,
      normalizedTable: buildNormalizedTable(metricSeriesMap),
    };
  }

  return { multiWindowData, rawFitbitCache: existingCache };
}

/**
 * Main entry point: fetch Fitbit data for all sub-analyses, compute evidence,
 * and persist everything to the bundle.
 *
 * @param {object} opts
 * @param {object} opts.bundle - QnaBundle document
 * @param {string} opts.username
 * @param {object[]} opts.subAnalyses - from planner: [{ id, label, metrics_needed, time_scope }]
 * @returns {Promise<{ multiWindowData, evidenceBundle, mergedTable }>}
 */
async function fetchAndComputeEvidence({ bundle, username, subAnalyses } = {}) {
  fetchLog("fetching data for sub-analyses", {
    bundleId: bundle?.bundleId,
    subAnalysisCount: subAnalyses?.length || 0,
  });

  const { multiWindowData, rawFitbitCache } = await fetchMultiWindowData({
    bundle,
    username,
    subAnalyses,
    fetchTimeoutMs: FETCH_TIMEOUT_MS,
  });

  const evidenceBundle = buildEvidenceBundle(multiWindowData);

  // Build merged table for backward compat
  const allRows = {};
  for (const sa of Object.values(multiWindowData)) {
    for (const row of (sa.normalizedTable || [])) {
      const key = row.timestamp;
      if (!allRows[key]) allRows[key] = { timestamp: key };
      Object.assign(allRows[key], row);
    }
  }
  const mergedTable = Object.values(allRows).sort((a, b) =>
    String(a.timestamp || "") < String(b.timestamp || "") ? -1 : 1
  );

  // Persist to bundle
  if (bundle?.bundleId) {
    await saveBundlePatch(bundle.bundleId, {
      rawFitbitCache,
      normalizedTable: mergedTable,
      multiWindowData,
      evidenceBundle,
    });
  }

  fetchLog("evidence computed", {
    bundleId: bundle?.bundleId,
    subAnalyses: Object.keys(multiWindowData).length,
    mergedRows: mergedTable.length,
  });

  return { multiWindowData, evidenceBundle, mergedTable };
}

module.exports = {
  fetchAndComputeEvidence,
  fetchMultiWindowData,
  computeDateWindow,
  buildFitbitInternalUrl,
  fetchJsonWithTimeout,
  mapMetricPayload,
  TIME_SCOPE_DAY_CONFIG,
  SLEEP_STAGE_METRICS,
};
