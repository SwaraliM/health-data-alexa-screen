/**
 * backend/services/analytics/evidenceComputer.js
 *
 * Pure deterministic math module that pre-computes statistical evidence
 * from normalizedTable rows so the LLM reasons about insights, not raw numbers.
 *
 * All functions are side-effect-free. No LLM calls, no I/O.
 *
 * Usage (in qnaOrchestrator.js after multi-window fetch):
 *   const { buildEvidenceBundle } = require("../analytics/evidenceComputer");
 *   const evidence = buildEvidenceBundle(multiWindowData);
 *   // evidence is ~30 lines of pre-computed facts vs 180 lines of raw data
 */

"use strict";

const { computeAverage, deriveUnit, formatMetricName } = require("../charts/metricExtractor");

// ─── Low-level helpers ────────────────────────────────────────────────────────

function toNumber(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractValues(rows, metricKey) {
  return (Array.isArray(rows) ? rows : [])
    .map((r) => toNumber(r?.[metricKey]))
    .filter((v) => v !== null);
}

function extractTimestampedValues(rows, metricKey) {
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => toNumber(r?.[metricKey]) !== null)
    .map((r) => ({ timestamp: String(r?.timestamp || ""), value: toNumber(r[metricKey]) }));
}

function getMetricColumns(rows) {
  if (!Array.isArray(rows) || !rows.length) return [];
  return Object.keys(rows[0] || {}).filter((k) => k !== "timestamp");
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function getDayOfWeek(timestamp) {
  try {
    const d = new Date(timestamp);
    return Number.isFinite(d.getTime()) ? DAY_NAMES[d.getDay()] : null;
  } catch (_) {
    return null;
  }
}

// ─── Per-metric statistics ────────────────────────────────────────────────────

/**
 * Compute comprehensive statistics for a single metric.
 *
 * @param {object[]} rows - normalizedTable rows
 * @param {string} metricKey
 * @returns {{ mean, median, min, max, stddev, latest, count, trend_direction, trend_slope, unit }}
 */
function computeMetricStats(rows, metricKey) {
  const values = extractValues(rows, metricKey);
  if (!values.length) {
    return {
      metric: metricKey,
      name: formatMetricName(metricKey),
      unit: deriveUnit(metricKey),
      count: 0,
      mean: null, median: null, min: null, max: null, stddev: null,
      latest: null, trend_direction: "unknown", trend_slope: null,
    };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const median = sorted.length % 2 === 0
    ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : sorted[Math.floor(sorted.length / 2)];
  const min = sorted[0];
  const max = sorted[sorted.length - 1];

  // Standard deviation
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  const stddev = Math.sqrt(variance);

  // Latest value (last non-null in original row order)
  const latest = values[values.length - 1];

  // Linear trend via least-squares regression
  const { slope, direction } = computeLinearTrend(values);

  return {
    metric: metricKey,
    name: formatMetricName(metricKey),
    unit: deriveUnit(metricKey),
    count: values.length,
    mean: round2(mean),
    median: round2(median),
    min: round2(min),
    max: round2(max),
    stddev: round2(stddev),
    latest: round2(latest),
    trend_direction: direction,
    trend_slope: round2(slope),
  };
}

function round2(v) {
  if (v === null || v === undefined) return null;
  return Math.round(v * 100) / 100;
}

/**
 * Simple linear regression on ordered values (index as x).
 * Returns slope and direction label.
 */
function computeLinearTrend(values) {
  if (!values.length || values.length < 2) {
    return { slope: null, direction: "unknown" };
  }

  const n = values.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumX2 += i * i;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return { slope: 0, direction: "stable" };

  const slope = (n * sumXY - sumX * sumY) / denom;
  const mean = sumY / n;

  // Normalize slope relative to mean to determine significance
  const relativeSlope = mean !== 0 ? slope / Math.abs(mean) : 0;

  let direction;
  if (Math.abs(relativeSlope) < 0.01) direction = "stable";
  else if (Math.abs(relativeSlope) < 0.05) direction = slope > 0 ? "slightly_rising" : "slightly_declining";
  else if (Math.abs(relativeSlope) < 0.15) direction = slope > 0 ? "rising" : "declining";
  else direction = slope > 0 ? "sharply_rising" : "sharply_declining";

  return { slope, direction };
}

// ─── Anomaly detection ────────────────────────────────────────────────────────

/**
 * Detect anomalies using z-score threshold.
 *
 * @param {object[]} rows - normalizedTable rows
 * @param {string} metricKey
 * @param {number} threshold - z-score threshold (default 2.0)
 * @returns {{ date, value, zscore, direction }[]}
 */
function detectAnomalies(rows, metricKey, threshold = 2.0) {
  const tsValues = extractTimestampedValues(rows, metricKey);
  if (tsValues.length < 3) return [];

  const values = tsValues.map((tv) => tv.value);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const stddev = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);

  if (stddev === 0) return [];

  const anomalies = [];
  for (const { timestamp, value } of tsValues) {
    const zscore = (value - mean) / stddev;
    if (Math.abs(zscore) >= threshold) {
      anomalies.push({
        date: timestamp,
        value: round2(value),
        zscore: round2(zscore),
        direction: zscore > 0 ? "high" : "low",
      });
    }
  }

  return anomalies;
}

// ─── Correlation ──────────────────────────────────────────────────────────────

/**
 * Compute Pearson correlation between two metrics.
 * Only uses rows where both metrics have non-null values.
 *
 * @param {object[]} rows
 * @param {string} metricA
 * @param {string} metricB
 * @returns {{ pearson_r, interpretation, description, sample_size }}
 */
function computeCorrelation(rows, metricA, metricB) {
  const pairs = (Array.isArray(rows) ? rows : [])
    .map((r) => ({ a: toNumber(r?.[metricA]), b: toNumber(r?.[metricB]) }))
    .filter((p) => p.a !== null && p.b !== null);

  if (pairs.length < 3) {
    return {
      metricA, metricB,
      pearson_r: null,
      interpretation: "insufficient_data",
      description: `Not enough overlapping data for ${formatMetricName(metricA)} and ${formatMetricName(metricB)}.`,
      sample_size: pairs.length,
    };
  }

  const n = pairs.length;
  let sumA = 0, sumB = 0, sumAB = 0, sumA2 = 0, sumB2 = 0;
  for (const { a, b } of pairs) {
    sumA += a;
    sumB += b;
    sumAB += a * b;
    sumA2 += a * a;
    sumB2 += b * b;
  }

  const numerator = n * sumAB - sumA * sumB;
  const denomA = n * sumA2 - sumA * sumA;
  const denomB = n * sumB2 - sumB * sumB;
  const denom = Math.sqrt(denomA * denomB);

  if (denom === 0) {
    return {
      metricA, metricB,
      pearson_r: 0,
      interpretation: "no_variation",
      description: `One or both metrics show no variation.`,
      sample_size: n,
    };
  }

  const r = numerator / denom;
  const absR = Math.abs(r);

  let interpretation;
  if (absR < 0.2) interpretation = "negligible";
  else if (absR < 0.4) interpretation = r > 0 ? "weak_positive" : "weak_negative";
  else if (absR < 0.6) interpretation = r > 0 ? "moderate_positive" : "moderate_negative";
  else if (absR < 0.8) interpretation = r > 0 ? "strong_positive" : "strong_negative";
  else interpretation = r > 0 ? "very_strong_positive" : "very_strong_negative";

  const nameA = formatMetricName(metricA);
  const nameB = formatMetricName(metricB);
  const dirWord = r > 0 ? "more" : "less";
  const description = absR < 0.2
    ? `No clear relationship between ${nameA} and ${nameB}.`
    : `Days with higher ${nameA} tended to have ${dirWord} ${nameB}.`;

  return {
    metricA, metricB,
    pearson_r: round2(r),
    interpretation,
    description,
    sample_size: n,
  };
}

// ─── Cross-period delta ───────────────────────────────────────────────────────

/**
 * Compute delta between two values (e.g., yesterday's sleep vs day-before's).
 *
 * @param {number} valueA - "current" or "later" value
 * @param {number} valueB - "previous" or "earlier" value (baseline)
 * @param {string} metricKey - for unit context
 * @returns {{ delta, delta_pct, direction, significance, unit }}
 */
function computeDelta(valueA, valueB, metricKey = "") {
  const a = toNumber(valueA);
  const b = toNumber(valueB);
  if (a === null || b === null) {
    return { delta: null, delta_pct: null, direction: "unknown", significance: "unknown", unit: deriveUnit(metricKey) };
  }

  const delta = a - b;
  const delta_pct = b !== 0 ? (delta / Math.abs(b)) * 100 : delta === 0 ? 0 : null;

  let direction;
  if (delta === 0) direction = "unchanged";
  else direction = delta > 0 ? "higher" : "lower";

  let significance;
  const absPct = Math.abs(delta_pct || 0);
  if (absPct < 3) significance = "trivial";
  else if (absPct < 10) significance = "minor";
  else if (absPct < 25) significance = "notable";
  else significance = "significant";

  return {
    delta: round2(delta),
    delta_pct: round2(delta_pct),
    direction,
    significance,
    unit: deriveUnit(metricKey),
  };
}

// ─── Day-of-week pattern ──────────────────────────────────────────────────────

/**
 * Compute average metric value by day of week.
 *
 * @param {object[]} rows
 * @param {string} metricKey
 * @returns {object} e.g. { Mon: 8200, Tue: 7400, ... }
 */
function computeDayOfWeekPattern(rows, metricKey) {
  const buckets = {};
  for (const day of DAY_NAMES) buckets[day] = [];

  for (const row of (Array.isArray(rows) ? rows : [])) {
    const val = toNumber(row?.[metricKey]);
    if (val === null) continue;
    const day = getDayOfWeek(row?.timestamp);
    if (day && buckets[day]) buckets[day].push(val);
  }

  const result = {};
  for (const day of DAY_NAMES) {
    const vals = buckets[day];
    result[day] = vals.length ? round2(vals.reduce((s, v) => s + v, 0) / vals.length) : null;
  }
  return result;
}

// ─── Per-sub-analysis evidence ────────────────────────────────────────────────

/**
 * Build evidence for a single sub-analysis window.
 *
 * @param {object} subAnalysis - { id, label, normalizedTable, metrics_needed, time_scope }
 * @returns {object} per-metric stats + anomalies + day-of-week patterns
 */
function buildSubAnalysisEvidence(subAnalysis) {
  const rows = Array.isArray(subAnalysis?.normalizedTable) ? subAnalysis.normalizedTable : [];
  const metrics = getMetricColumns(rows);

  const metricEvidence = {};
  for (const metric of metrics) {
    const stats = computeMetricStats(rows, metric);
    const anomalies = detectAnomalies(rows, metric);
    const dayPattern = rows.length >= 7 ? computeDayOfWeekPattern(rows, metric) : null;

    metricEvidence[metric] = {
      ...stats,
      anomalies,
      ...(dayPattern ? { day_of_week_pattern: dayPattern } : {}),
    };
  }

  return {
    id: subAnalysis.id || "sa_0",
    label: subAnalysis.label || "",
    time_scope: subAnalysis.time_scope || "",
    row_count: rows.length,
    metrics: metricEvidence,
  };
}

// ─── Cross-analysis evidence ──────────────────────────────────────────────────

/**
 * Build cross-analysis comparisons: deltas between sub-analyses and correlations.
 *
 * @param {object[]} subAnalysisEvidences - array of per-sub-analysis evidence objects
 * @param {object} multiWindowData - { [saId]: { normalizedTable, ... } }
 * @returns {object} { deltas: { "sa_0_vs_sa_1": { metric: deltaObj } }, correlations: { ... } }
 */
function buildCrossAnalysisEvidence(subAnalysisEvidences, multiWindowData) {
  const result = { deltas: {}, correlations: {} };

  // Pairwise deltas between sub-analyses that share metrics
  for (let i = 0; i < subAnalysisEvidences.length; i++) {
    for (let j = i + 1; j < subAnalysisEvidences.length; j++) {
      const saA = subAnalysisEvidences[i];
      const saB = subAnalysisEvidences[j];
      const key = `${saA.id}_vs_${saB.id}`;
      const sharedMetrics = Object.keys(saA.metrics).filter((m) => saB.metrics[m]);

      if (!sharedMetrics.length) continue;

      const deltaMap = {};
      for (const metric of sharedMetrics) {
        const valueA = saA.metrics[metric]?.mean ?? saA.metrics[metric]?.latest;
        const valueB = saB.metrics[metric]?.mean ?? saB.metrics[metric]?.latest;
        deltaMap[metric] = computeDelta(valueA, valueB, metric);
      }
      result.deltas[key] = deltaMap;
    }
  }

  // Pairwise correlations within each sub-analysis that has enough data
  for (const sa of subAnalysisEvidences) {
    const metrics = Object.keys(sa.metrics).filter((m) => (sa.metrics[m]?.count || 0) >= 3);
    if (metrics.length < 2) continue;

    const saData = multiWindowData?.[sa.id];
    const rows = Array.isArray(saData?.normalizedTable) ? saData.normalizedTable : [];
    if (rows.length < 3) continue;

    for (let i = 0; i < metrics.length; i++) {
      for (let j = i + 1; j < metrics.length; j++) {
        const corrKey = `${metrics[i]}_vs_${metrics[j]}`;
        if (!result.correlations[corrKey]) {
          result.correlations[corrKey] = computeCorrelation(rows, metrics[i], metrics[j]);
        }
      }
    }
  }

  return result;
}

// ─── Main bundle builder ──────────────────────────────────────────────────────

/**
 * Build the full evidence bundle from multi-window data.
 *
 * @param {object} multiWindowData - { [saId]: { id, label, normalizedTable, metrics_needed, time_scope } }
 * @returns {object} { sub_analyses: { [saId]: evidence }, cross_analysis: { deltas, correlations } }
 */
function buildEvidenceBundle(multiWindowData) {
  if (!multiWindowData || typeof multiWindowData !== "object") {
    return { sub_analyses: {}, cross_analysis: { deltas: {}, correlations: {} } };
  }

  const saIds = Object.keys(multiWindowData);
  const subAnalysisEvidences = [];
  const subAnalysisMap = {};

  for (const saId of saIds) {
    const sa = multiWindowData[saId];
    const evidence = buildSubAnalysisEvidence(sa);
    subAnalysisEvidences.push(evidence);
    subAnalysisMap[saId] = evidence;
  }

  const crossAnalysis = buildCrossAnalysisEvidence(subAnalysisEvidences, multiWindowData);

  return {
    sub_analyses: subAnalysisMap,
    cross_analysis: crossAnalysis,
  };
}

/**
 * Build evidence from a single normalizedTable (backward compat for simple questions).
 * Wraps the table as a single sub-analysis.
 *
 * @param {object[]} normalizedTable
 * @param {string} timeScope
 * @returns {object} same shape as buildEvidenceBundle output
 */
function buildEvidenceFromTable(normalizedTable, timeScope = "last_7_days") {
  return buildEvidenceBundle({
    sa_0: {
      id: "sa_0",
      label: "primary",
      normalizedTable,
      time_scope: timeScope,
    },
  });
}

module.exports = {
  // Per-metric
  computeMetricStats,
  detectAnomalies,
  computeDayOfWeekPattern,

  // Cross-metric / cross-period
  computeCorrelation,
  computeDelta,

  // Builders
  buildSubAnalysisEvidence,
  buildCrossAnalysisEvidence,
  buildEvidenceBundle,
  buildEvidenceFromTable,

  // Internal (exported for testing)
  computeLinearTrend,
  extractValues,
  round2,
};
