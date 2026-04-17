/**
 * backend/services/charts/metricExtractor.js
 *
 * Extracts and aggregates metric data from normalizedTable rows into
 * chart-ready shapes for the template-fill executor path (v2).
 *
 * normalizedTable format:
 *   [{ timestamp: "2024-01-06", steps: 8000, sleep_minutes: 420, resting_hr: 65 }, ...]
 *
 * Timestamps can be:
 *   "2024-01-06"               → daily row   → label: "Jan 6"
 *   "2024-01-06T09:00:00"      → intraday    → label: "9am"
 *   "09:00"                    → intraday    → label: "9am"
 */

"use strict";

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ─── Low-level helpers ────────────────────────────────────────────────────────

function toNumber(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Convert a timestamp string to a short human-readable label.
 */
function formatDateLabel(ts) {
  if (!ts || typeof ts !== "string") return String(ts || "");
  // Intraday: has a time component "T09:00" or " 09:00" or plain "09:00"
  const timeMatch = ts.match(/(?:[T ]|^)(\d{1,2}):(\d{2})/);
  if (timeMatch) {
    const hour = parseInt(timeMatch[1], 10);
    const ampm = hour >= 12 ? "pm" : "am";
    const display = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
    return `${display}${ampm}`;
  }
  // Daily: "2024-01-06"
  const dateMatch = ts.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (dateMatch) {
    const month = parseInt(dateMatch[2], 10) - 1;
    const day = parseInt(dateMatch[3], 10);
    return `${MONTH_ABBR[month] || "?"} ${day}`;
  }
  return ts.slice(0, 12);
}

/**
 * Humanize a snake_case metric key → "Resting Hr"
 */
function formatMetricName(key) {
  return String(key || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Sort rows ascending by timestamp string.
 */
function sortedRows(rows) {
  if (!Array.isArray(rows)) return [];
  return [...rows].sort((a, b) => {
    const tsA = String(a?.timestamp || "");
    const tsB = String(b?.timestamp || "");
    return tsA < tsB ? -1 : tsA > tsB ? 1 : 0;
  });
}

// ─── Public extraction functions ──────────────────────────────────────────────

/**
 * Extract a single daily metric series.
 * Rows with null/missing values for metricKey are skipped.
 *
 * @returns {{ labels: string[], values: (number|null)[], seriesName: string }}
 */
function extractDailySeries(rows, metricKey) {
  const sorted = sortedRows(rows);
  const labels = [];
  const values = [];
  for (const row of sorted) {
    const val = toNumber(row?.[metricKey]);
    if (val === null) continue;
    labels.push(formatDateLabel(String(row.timestamp || "")));
    values.push(val);
  }
  return { labels, values, seriesName: formatMetricName(metricKey) };
}

/**
 * Extract multiple metric series aligned by timestamp.
 * Rows missing ALL requested metrics are excluded from labels.
 * Individual missing values within a row become null.
 *
 * @returns {{ labels: string[], series: { name: string, data: (number|null)[] }[] }}
 */
function extractMultiMetricSeries(rows, metricKeys) {
  const sorted = sortedRows(rows);
  const keys = Array.isArray(metricKeys) ? metricKeys : [];
  const validRows = sorted.filter((row) =>
    keys.some((k) => toNumber(row?.[k]) !== null)
  );
  const labels = validRows.map((row) => formatDateLabel(String(row.timestamp || "")));
  const series = keys.map((key) => ({
    name: formatMetricName(key),
    data: validRows.map((row) => toNumber(row?.[key])),
  }));
  return { labels, series };
}

/**
 * Extract scatter points from two metric columns.
 * Rows missing either metric are excluded.
 *
 * @returns {{ points: { x: number, y: number, label: string }[], x_name: string, y_name: string }}
 */
function extractScatterPoints(rows, metricX, metricY) {
  const sorted = sortedRows(rows);
  const points = [];
  for (const row of sorted) {
    const x = toNumber(row?.[metricX]);
    const y = toNumber(row?.[metricY]);
    if (x === null || y === null) continue;
    points.push({ x, y, label: formatDateLabel(String(row.timestamp || "")) });
  }
  return {
    points,
    x_name: formatMetricName(metricX),
    y_name: formatMetricName(metricY),
  };
}

/**
 * Split rows roughly in half to produce a "current vs previous period" comparison.
 * First half = Previous, second half = Current.
 * Uses date-sorted rows, fills mismatched lengths with null.
 *
 * @returns {{ labels: string[], series: { name: string, data: (number|null)[] }[] }}
 */
function extractComparisonSeries(rows, metricKey) {
  const sorted = sortedRows(rows).filter((row) => toNumber(row?.[metricKey]) !== null);
  if (!sorted.length) return { labels: [], series: [] };
  const mid = Math.ceil(sorted.length / 2);
  const previousRows = sorted.slice(0, mid);
  const currentRows = sorted.slice(mid);
  const maxLen = Math.max(previousRows.length, currentRows.length);
  const labels = Array.from({ length: maxLen }, (_, i) => {
    const row = currentRows[i] || previousRows[i];
    return formatDateLabel(String(row?.timestamp || ""));
  });
  const currentData = Array.from({ length: maxLen }, (_, i) =>
    toNumber(currentRows[i]?.[metricKey])
  );
  const previousData = Array.from({ length: maxLen }, (_, i) =>
    toNumber(previousRows[i]?.[metricKey])
  );
  return {
    labels,
    series: [
      { name: "Previous", data: previousData },
      { name: "Current", data: currentData },
    ],
  };
}

/**
 * Extract a gauge value from the most recent non-null row for a metric.
 *
 * @param {object[]} rows - normalizedTable rows
 * @param {string}   metricKey
 * @param {number|null} goal - optional user goal (used as max)
 * @returns {{ value: number, min: number, max: number, unit: string }}
 */
function extractGaugeValue(rows, metricKey, goal = null) {
  const sorted = sortedRows(rows);
  let value = null;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const v = toNumber(sorted[i]?.[metricKey]);
    if (v !== null) { value = v; break; }
  }
  const max = toNumber(goal) || deriveMax(metricKey, value);
  return { value: value ?? 0, min: 0, max, unit: deriveUnit(metricKey) };
}

/**
 * Build list_summary cards + items from the most recent value of each metric.
 *
 * @returns {{ cards: { label, value, subvalue }[], items: string[] }}
 */
function extractListSummaryCards(rows, metricKeys) {
  const sorted = sortedRows(rows);
  const cards = [];
  const items = [];
  for (const key of (Array.isArray(metricKeys) ? metricKeys : []).slice(0, 4)) {
    let recentValue = null;
    let recentLabel = "";
    for (let i = sorted.length - 1; i >= 0; i--) {
      const v = toNumber(sorted[i]?.[key]);
      if (v !== null) {
        recentValue = v;
        recentLabel = formatDateLabel(String(sorted[i]?.timestamp || ""));
        break;
      }
    }
    if (recentValue === null) continue;
    const unit = deriveUnit(key);
    const displayValue = unit ? `${recentValue} ${unit}` : String(recentValue);
    cards.push({ label: formatMetricName(key), value: displayValue, subvalue: recentLabel });
    items.push(`${formatMetricName(key)}: ${displayValue}`);
  }
  return { cards, items };
}

/**
 * Extract heatmap data as [dayIndex, metricIndex, normalizedValue] triples.
 * Used for day-of-week pattern heatmaps and multi-metric heatmaps.
 *
 * @param {object[]} rows - normalizedTable rows
 * @param {string[]} metricKeys - metrics to include on y-axis
 * @param {"day_of_week"|"date"} xMode - x-axis grouping
 * @returns {{ xLabels: string[], yLabels: string[], data: [number, number, number][] }}
 */
function extractHeatmapData(rows, metricKeys, xMode = "day_of_week") {
  const keys = Array.isArray(metricKeys) && metricKeys.length ? metricKeys : [];
  if (!keys.length || !Array.isArray(rows) || !rows.length) {
    return { xLabels: [], yLabels: [], data: [] };
  }

  const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const yLabels = keys.map(formatMetricName);

  if (xMode === "day_of_week") {
    // Build day-of-week average buckets for each metric
    const buckets = {}; // { metricKey: { Mon: [], Tue: [], ... } }
    for (const key of keys) {
      buckets[key] = {};
      for (const d of DAY_NAMES) buckets[key][d] = [];
    }

    for (const row of rows) {
      const ts = String(row?.timestamp || "");
      const dateMatch = ts.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (!dateMatch) continue;
      const dayIdx = new Date(ts).getDay(); // 0=Sun
      const dayName = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dayIdx];
      // Remap to Mon-first
      const monFirstDay = dayName === "Sun" ? "Sun" : dayName;
      for (const key of keys) {
        const val = toNumber(row?.[key]);
        if (val !== null && buckets[key][monFirstDay]) {
          buckets[key][monFirstDay].push(val);
        }
      }
    }

    // Compute per-metric averages and normalize to 0-100
    const data = [];
    for (let mi = 0; mi < keys.length; mi++) {
      const key = keys[mi];
      const dayAverages = DAY_NAMES.map((d) => {
        const vals = buckets[key][d] || [];
        return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
      });
      const validVals = dayAverages.filter((v) => v !== null);
      const minVal = validVals.length ? Math.min(...validVals) : 0;
      const maxVal = validVals.length ? Math.max(...validVals) : 1;
      const range = maxVal - minVal || 1;

      for (let di = 0; di < DAY_NAMES.length; di++) {
        const avg = dayAverages[di];
        if (avg !== null) {
          const normalized = Math.round(((avg - minVal) / range) * 100);
          data.push([di, mi, normalized]);
        }
      }
    }

    return { xLabels: DAY_NAMES, yLabels, data };
  }

  // xMode === "date": use actual date labels
  const sorted = sortedRows(rows);
  const xLabels = sorted.map((row) => formatDateLabel(String(row.timestamp || "")));
  const data = [];

  for (let mi = 0; mi < keys.length; mi++) {
    const key = keys[mi];
    const vals = sorted.map((row) => toNumber(row?.[key]));
    const validVals = vals.filter((v) => v !== null);
    const minVal = validVals.length ? Math.min(...validVals) : 0;
    const maxVal = validVals.length ? Math.max(...validVals) : 1;
    const range = maxVal - minVal || 1;

    for (let di = 0; di < sorted.length; di++) {
      const val = vals[di];
      if (val !== null) {
        const normalized = Math.round(((val - minVal) / range) * 100);
        data.push([di, mi, normalized]);
      }
    }
  }

  return { xLabels, yLabels, data };
}

/**
 * Extract donut chart data: slices + center value/label.
 * Uses the most recent row's values for slice proportions.
 *
 * @param {object[]} rows - normalizedTable rows
 * @param {string} primaryMetric - metric shown in center (latest value)
 * @param {string[]} sliceMetrics - metrics that form the ring slices (defaults to [primaryMetric])
 * @returns {{ slices: { name, value }[], centerValue: number|null, centerLabel: string, unit: string }}
 */
function extractDonutData(rows, primaryMetric, sliceMetrics = null) {
  const sorted = sortedRows(rows);
  const lastRow = sorted[sorted.length - 1] || {};

  // Latest value for center display
  let centerValue = null;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const v = toNumber(sorted[i]?.[primaryMetric]);
    if (v !== null) { centerValue = v; break; }
  }

  const metricsForSlices = Array.isArray(sliceMetrics) && sliceMetrics.length
    ? sliceMetrics
    : [primaryMetric];

  const slices = metricsForSlices
    .map((m) => ({ name: formatMetricName(m), value: toNumber(lastRow[m]) }))
    .filter((s) => s.value != null && s.value > 0);

  return {
    slices,
    centerValue,
    centerLabel: formatMetricName(primaryMetric),
    unit: deriveUnit(primaryMetric),
  };
}

/**
 * Compute the arithmetic mean of a metric across all rows (ignoring nulls).
 * Returns null if no valid values exist.
 *
 * @returns {number|null}
 */
function computeAverage(rows, metricKey) {
  const values = (Array.isArray(rows) ? rows : [])
    .map((r) => toNumber(r?.[metricKey]))
    .filter((v) => v !== null);
  if (!values.length) return null;
  return Math.round(values.reduce((sum, v) => sum + v, 0) / values.length);
}

/**
 * Detect whether normalizedTable rows are intraday (timestamp has time component).
 */
function isIntradayTable(rows) {
  return (Array.isArray(rows) ? rows : []).slice(0, 5).some(
    (row) => /(?:[T ]\d{1,2}:\d{2}|^\d{1,2}:\d{2})/.test(String(row?.timestamp || ""))
  );
}

// ─── Metric metadata helpers ──────────────────────────────────────────────────

/**
 * Derive a reasonable axis maximum for a metric key.
 * Used when no goal is provided.
 */
function deriveMax(metricKey, currentValue = null) {
  const known = {
    steps: 15000, distance: 10, floors: 30, elevation: 100,
    calories: 3000, sleep_minutes: 600, sleep_efficiency: 100,
    wake_minutes: 120, breathing_rate: 20, spo2: 100,
    weight: 200, body_fat: 50, resting_hr: 120, hrv: 100,
  };
  if (known[metricKey] != null) return known[metricKey];
  if (currentValue != null && currentValue > 0) return Math.ceil(currentValue * 1.5);
  return 100;
}

/**
 * Return a short unit label for a known metric key.
 */
function deriveUnit(metricKey) {
  const units = {
    steps: "steps", distance: "mi", floors: "floors", elevation: "ft",
    calories: "cal", sleep_minutes: "min", sleep_efficiency: "%",
    wake_minutes: "min", breathing_rate: "br/min", spo2: "%",
    weight: "lbs", body_fat: "%", resting_hr: "bpm", hrv: "ms",
  };
  return units[metricKey] || "";
}

module.exports = {
  extractDailySeries,
  extractMultiMetricSeries,
  extractScatterPoints,
  extractComparisonSeries,
  extractGaugeValue,
  extractListSummaryCards,
  extractHeatmapData,
  extractDonutData,
  computeAverage,
  isIntradayTable,
  formatMetricName,
  deriveUnit,
  deriveMax,
  formatDateLabel,
};
