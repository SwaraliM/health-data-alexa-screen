/**
 * backend/services/fitbit/endpointAdapters.js
 *
 * Phase 1 endpoint adapters:
 * - Convert Fitbit endpoint-specific JSON shapes into one lightweight list format.
 * - Keep logic limited to payload-shape adaptation only (no cross-metric analysis).
 * - Preserve rich metadata per point so future phases can reason with raw context.
 *
 * TODO(phase2): Attach timezone/context normalization once orchestrator passes locale hints.
 */

const ADAPTER_DEBUG = process.env.FITBIT_ADAPTER_DEBUG !== "false";

function adapterLog(message, data = null) {
  if (!ADAPTER_DEBUG) return;
  if (data == null) return console.log(`[FitbitAdapters] ${message}`);
  console.log(`[FitbitAdapters] ${message}`, data);
}

function safeNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function extractNumericValue(value) {
  const direct = safeNumber(value);
  if (direct != null) return direct;

  if (!value || typeof value !== "object") return null;
  for (const inner of Object.values(value)) {
    const nested = safeNumber(inner);
    if (nested != null) return nested;
  }
  return null;
}

function inferLabelFromTimestamp(timestamp = "") {
  const raw = String(timestamp || "").trim();
  if (!raw) return "";

  // Daily series typically use YYYY-MM-DD.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  // Intraday series use either HH:mm[:ss] or ISO datetime.
  if (/^\d{2}:\d{2}(:\d{2})?$/.test(raw)) return raw.slice(0, 5);

  const asDate = new Date(raw);
  if (!Number.isNaN(asDate.getTime())) {
    const hh = String(asDate.getHours()).padStart(2, "0");
    const mm = String(asDate.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }

  return raw;
}

function withDateAndTime(date, time) {
  const cleanDate = String(date || "").trim();
  const cleanTime = String(time || "").trim();
  if (!cleanDate && !cleanTime) return "";
  if (!cleanDate) return cleanTime;
  if (!cleanTime) return cleanDate;
  return `${cleanDate}T${cleanTime}`;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function mapDailySeries(payload, keys, metric) {
  const sourceKey = keys.find((key) => Array.isArray(payload?.[key])) || null;
  const rows = sourceKey ? asArray(payload?.[sourceKey]) : [];

  const adapted = rows
    .map((item) => {
      const timestamp = String(item?.dateTime || item?.date || "").trim();
      const value = extractNumericValue(item?.value);
      if (!timestamp || value == null) return null;

      return {
        timestamp,
        label: inferLabelFromTimestamp(timestamp),
        metric,
        value,
        meta: {
          sourceKey,
        },
      };
    })
    .filter(Boolean);

  adapterLog("daily metric adapted", {
    metric,
    sourceKey,
    points: adapted.length,
  });
  return adapted;
}

/**
 * /activities/:resource/date/:start/:end -> activities-{resource}
 */
function adaptStepsRange(payload) {
  return mapDailySeries(payload, ["activities-steps"], "steps");
}

function adaptCaloriesRange(payload) {
  return mapDailySeries(payload, ["activities-calories"], "calories");
}

function adaptDistanceRange(payload) {
  return mapDailySeries(payload, ["activities-distance"], "distance");
}

function adaptFloorsRange(payload) {
  return mapDailySeries(payload, ["activities-floors"], "floors");
}

function adaptElevationRange(payload) {
  return mapDailySeries(payload, ["activities-elevation"], "elevation");
}

/**
 * /sleep/date/:start/:end -> sleep[]
 * Keep one representative log per date (main sleep preferred, else longest).
 */
function adaptSleepRange(payload) {
  const logs = asArray(payload?.sleep);
  const bestByDate = new Map();

  logs.forEach((entry) => {
    const dateKey = String(entry?.dateOfSleep || entry?.dateTime || "").trim();
    if (!dateKey) return;

    const minutesAsleep = safeNumber(entry?.minutesAsleep);
    const durationMinutes = safeNumber(entry?.duration) != null
      ? safeNumber(entry?.duration) / 60000
      : null;
    const sleepMinutes = minutesAsleep != null ? minutesAsleep : durationMinutes;
    if (sleepMinutes == null) return;

    const current = bestByDate.get(dateKey);
    const isMainSleep = Boolean(entry?.isMainSleep);
    const score = (isMainSleep ? 10_000 : 0) + sleepMinutes;
    if (!current || score > current.score) {
      bestByDate.set(dateKey, { entry, score, sleepMinutes });
    }
  });

  const adapted = [...bestByDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([dateKey, picked]) => {
      const item = picked.entry;
      return {
        timestamp: dateKey,
        label: inferLabelFromTimestamp(dateKey),
        metric: "sleep_minutes",
        value: picked.sleepMinutes,
        meta: {
          isMainSleep: Boolean(item?.isMainSleep),
          efficiency: safeNumber(item?.efficiency),
          minutesAwake: safeNumber(item?.minutesAwake),
          timeInBed: safeNumber(item?.timeInBed),
          startTime: item?.startTime || null,
          endTime: item?.endTime || null,
        },
      };
    });

  adapterLog("sleep metric adapted", { points: adapted.length });
  return adapted;
}

/**
 * /activities/heart/date/:start/:end -> activities-heart[]
 */
function adaptRestingHeartRateRange(payload) {
  const rows = asArray(payload?.["activities-heart"]);
  const adapted = rows
    .map((item) => {
      const timestamp = String(item?.dateTime || item?.date || "").trim();
      const resting = safeNumber(item?.value?.restingHeartRate);
      if (!timestamp || resting == null) return null;
      return {
        timestamp,
        label: inferLabelFromTimestamp(timestamp),
        metric: "resting_hr",
        value: resting,
        meta: {
          sourceKey: "activities-heart",
        },
      };
    })
    .filter(Boolean);

  adapterLog("resting heart rate adapted", { points: adapted.length });
  return adapted;
}

/**
 * /hrv/date/:start/:end -> hrv[] (or activities-hrv[] in some payload variants)
 */
function adaptHrvRange(payload) {
  const sourceKey = Array.isArray(payload?.hrv) ? "hrv" : Array.isArray(payload?.["activities-hrv"]) ? "activities-hrv" : null;
  const rows = sourceKey ? asArray(payload?.[sourceKey]) : [];

  const adapted = rows
    .map((item) => {
      const timestamp = String(item?.dateTime || item?.date || "").trim();
      const value = extractNumericValue(item?.value?.dailyRmssd ?? item?.value?.rmssd ?? item?.value);
      if (!timestamp || value == null) return null;
      return {
        timestamp,
        label: inferLabelFromTimestamp(timestamp),
        metric: "hrv",
        value,
        meta: {
          sourceKey,
        },
      };
    })
    .filter(Boolean);

  adapterLog("hrv adapted", { points: adapted.length, sourceKey });
  return adapted;
}

/**
 * /activities/heart/date/:date/1d/1min -> activities-heart-intraday.dataset[]
 */
function adaptIntradayHeart(payload) {
  const dataset = asArray(payload?.["activities-heart-intraday"]?.dataset);
  const summaryDate = String(payload?.["activities-heart"]?.[0]?.dateTime || "").trim();

  const adapted = dataset
    .map((item) => {
      const time = String(item?.time || "").trim();
      const value = safeNumber(item?.value);
      if (!time || value == null) return null;
      const timestamp = withDateAndTime(summaryDate, time);
      return {
        timestamp: timestamp || time,
        label: inferLabelFromTimestamp(time),
        metric: "heart_intraday",
        value,
        meta: {
          date: summaryDate || null,
          level: item?.level || null,
        },
      };
    })
    .filter(Boolean);

  adapterLog("intraday heart adapted", { points: adapted.length });
  return adapted;
}

/**
 * /activities/:resource/date/:date/1d/1min -> activities-{resource}-intraday.dataset[]
 */
function adaptIntradayActivity(payload, resourceKey) {
  const resource = String(resourceKey || "").trim().toLowerCase();
  if (!resource) return [];

  const datasetKey = `activities-${resource}-intraday`;
  const summaryKey = `activities-${resource}`;
  const dataset = asArray(payload?.[datasetKey]?.dataset);
  const summaryDate = String(payload?.[summaryKey]?.[0]?.dateTime || "").trim();
  const metric = `${resource}_intraday`;

  const adapted = dataset
    .map((item) => {
      const time = String(item?.time || "").trim();
      const value = safeNumber(item?.value);
      if (!time || value == null) return null;
      const timestamp = withDateAndTime(summaryDate, time);
      return {
        timestamp: timestamp || time,
        label: inferLabelFromTimestamp(time),
        metric,
        value,
        meta: {
          resource,
          date: summaryDate || null,
          datasetType: payload?.[datasetKey]?.datasetType || null,
          interval: payload?.[datasetKey]?.datasetInterval || null,
        },
      };
    })
    .filter(Boolean);

  adapterLog("intraday activity adapted", {
    metric,
    datasetKey,
    points: adapted.length,
  });
  return adapted;
}

module.exports = {
  adaptStepsRange,
  adaptCaloriesRange,
  adaptDistanceRange,
  adaptFloorsRange,
  adaptElevationRange,
  adaptSleepRange,
  adaptRestingHeartRateRange,
  adaptHrvRange,
  adaptIntradayHeart,
  adaptIntradayActivity,
};
