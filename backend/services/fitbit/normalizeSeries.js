/**
 * backend/services/fitbit/normalizeSeries.js
 *
 * Phase 1 lightweight normalization helpers.
 * These functions intentionally stay narrow:
 * - group points by metric
 * - align by timestamp
 * - emit a GPT-friendly wide table
 *
 * No heavy analytics should live here.
 * TODO(phase2): Add optional provenance map output for per-cell source tracing.
 */

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeTimestamp(value) {
  const text = String(value || "").trim();
  return text || "";
}

function parseTimestamp(value) {
  const text = normalizeTimestamp(value);
  if (!text) return Number.NaN;
  const parsed = new Date(text).getTime();
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

/**
 * Stable ascending timestamp sort.
 * - ISO date / ISO datetime values use real time ordering.
 * - Non-ISO strings fall back to lexical ordering.
 */
function sortByTimestamp(rows = []) {
  return (Array.isArray(rows) ? rows.slice() : []).sort((a, b) => {
    const tsA = normalizeTimestamp(a?.timestamp);
    const tsB = normalizeTimestamp(b?.timestamp);
    const parsedA = parseTimestamp(tsA);
    const parsedB = parseTimestamp(tsB);

    if (!Number.isNaN(parsedA) && !Number.isNaN(parsedB)) return parsedA - parsedB;
    if (!Number.isNaN(parsedA)) return -1;
    if (!Number.isNaN(parsedB)) return 1;
    return tsA.localeCompare(tsB);
  });
}

function normalizePoint(point = {}, forcedMetric = "") {
  const timestamp = normalizeTimestamp(point?.timestamp || point?.dateTime || point?.date);
  const metric = String(point?.metric || forcedMetric || "").trim().toLowerCase();
  const value = safeNumber(point?.value);
  if (!timestamp || !metric || value == null) return null;

  return {
    timestamp,
    label: String(point?.label || "").trim(),
    metric,
    value,
    meta: point?.meta && typeof point.meta === "object" ? point.meta : {},
  };
}

/**
 * Accepts:
 * - flat list of points
 * - list of point-lists
 * - metric map ({ steps: [...], resting_hr: [...] })
 */
function groupSeriesByMetric(seriesList) {
  const grouped = {};

  if (Array.isArray(seriesList)) {
    seriesList.forEach((entry) => {
      if (Array.isArray(entry)) {
        entry.forEach((point) => {
          const normalized = normalizePoint(point);
          if (!normalized) return;
          grouped[normalized.metric] = grouped[normalized.metric] || [];
          grouped[normalized.metric].push(normalized);
        });
        return;
      }

      const normalized = normalizePoint(entry);
      if (!normalized) return;
      grouped[normalized.metric] = grouped[normalized.metric] || [];
      grouped[normalized.metric].push(normalized);
    });
  } else if (seriesList && typeof seriesList === "object") {
    Object.entries(seriesList).forEach(([metricKey, points]) => {
      (Array.isArray(points) ? points : []).forEach((point) => {
        const normalized = normalizePoint(point, metricKey);
        if (!normalized) return;
        grouped[normalized.metric] = grouped[normalized.metric] || [];
        grouped[normalized.metric].push(normalized);
      });
    });
  }

  Object.keys(grouped).forEach((metric) => {
    grouped[metric] = sortByTimestamp(grouped[metric]);
  });

  return grouped;
}

/**
 * Converts metric-keyed series into aligned row objects:
 * [
 *   { timestamp: "2026-03-01", steps: 8200, resting_hr: 62 },
 *   { timestamp: "2026-03-02", steps: 9700, resting_hr: 60 }
 * ]
 */
function alignSeriesOnTimestamp(metricSeriesMap = {}) {
  const map = metricSeriesMap && typeof metricSeriesMap === "object" ? metricSeriesMap : {};
  const metrics = Object.keys(map);
  const rowByTimestamp = new Map();

  metrics.forEach((metric) => {
    const points = Array.isArray(map[metric]) ? map[metric] : [];
    points.forEach((point) => {
      const normalized = normalizePoint(point, metric);
      if (!normalized) return;

      const key = normalized.timestamp;
      if (!rowByTimestamp.has(key)) {
        rowByTimestamp.set(key, { timestamp: key });
      }

      const row = rowByTimestamp.get(key);
      row[normalized.metric] = normalized.value;
    });
  });

  const rows = sortByTimestamp([...rowByTimestamp.values()]);

  // Fill missing metric values explicitly with null for GPT readability.
  return rows.map((row) => {
    const complete = { timestamp: row.timestamp };
    metrics.forEach((metric) => {
      complete[metric] = row[metric] == null ? null : row[metric];
    });
    return complete;
  });
}

/**
 * Converts a long-form metric stream into a wide table.
 * Input example:
 * [
 *   { timestamp: "...", metric: "steps", value: 100 },
 *   { timestamp: "...", metric: "resting_hr", value: 62 }
 * ]
 */
function buildWideTable(rows = []) {
  const list = Array.isArray(rows) ? rows : [];

  // If rows already look wide (no metric/value fields), keep them sorted.
  const looksLong = list.some((row) => row && row.metric != null && row.value != null);
  if (!looksLong) return sortByTimestamp(list);

  const grouped = groupSeriesByMetric(list);
  return alignSeriesOnTimestamp(grouped);
}

/**
 * Convenience entry-point used by future orchestrator code.
 */
function buildNormalizedTable(metricSeriesMap = {}) {
  const grouped = Array.isArray(metricSeriesMap)
    ? groupSeriesByMetric(metricSeriesMap)
    : groupSeriesByMetric(metricSeriesMap || {});
  return alignSeriesOnTimestamp(grouped);
}

module.exports = {
  groupSeriesByMetric,
  alignSeriesOnTimestamp,
  buildNormalizedTable,
  buildWideTable,
  sortByTimestamp,
};
