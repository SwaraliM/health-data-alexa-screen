/**
 * backend/services/charts/chartTemplateBuilder.js
 *
 * Builds pre-populated chart template candidates for each executor stage.
 *
 * Problem this solves:
 *   The executor GPT must output chart_data JSON with type-specific fields.
 *   Different chart types need different fields (labels+series vs points vs slices
 *   vs indicators), which causes frequent malformed output.
 *
 * Solution:
 *   Backend pre-extracts all data from normalizedTable and produces 2 ready-made
 *   chart templates per stage. GPT only picks the best index and fills text.
 *
 * Usage (in executorAgent.js):
 *   const candidates = buildTemplatesForStage({
 *     normalizedTable, plannerOutput, stageIndex, previousStageTypes, rawFitbitCache
 *   });
 *   // → [{ index: 0, chart_type: "bar", description: "…", chart_data: {…} }, …]
 *
 * The returned template_candidates are injected into the executor prompt so GPT can:
 *   1. Choose selected_template_index
 *   2. Write chart_title, chart_subtitle, chart_takeaway (text only)
 *
 * After GPT responds, executorAgent.js merges the template chart_data with GPT's
 * text fills → passes to normalizeChartSpec → hydrateChartSpec → ECharts option.
 */

"use strict";

const {
  extractDailySeries,
  extractMultiMetricSeries,
  extractScatterPoints,
  extractComparisonSeries,
  extractGaugeValue,
  extractListSummaryCards,
  computeAverage,
  formatMetricName,
  deriveUnit,
} = require("./metricExtractor");

const TEMPLATE_DEBUG = process.env.QNA_TEMPLATE_DEBUG !== "false";
const MAX_CANDIDATES = Math.max(1, Number(process.env.TEMPLATE_CANDIDATE_COUNT) || 2);

function templateLog(msg, data = null) {
  if (!TEMPLATE_DEBUG) return;
  if (data == null) return console.log(`[ChartTemplateBuilder] ${msg}`);
  console.log(`[ChartTemplateBuilder] ${msg}`, data);
}

function toNumber(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// ─── Column helpers ───────────────────────────────────────────────────────────

function getAvailableColumns(normalizedTable) {
  const rows = Array.isArray(normalizedTable) ? normalizedTable : [];
  if (!rows.length) return [];
  return Object.keys(rows[0] || {}).filter((k) => k !== "timestamp");
}

function pickPrimaryMetric(metricsNeeded, availableColumns) {
  const cols = new Set(availableColumns);
  for (const m of (Array.isArray(metricsNeeded) ? metricsNeeded : [])) {
    if (cols.has(m)) return m;
  }
  return availableColumns[0] || null;
}

function pickSecondaryMetric(metricsNeeded, availableColumns, exclude) {
  const cols = new Set(availableColumns);
  for (const m of (Array.isArray(metricsNeeded) ? metricsNeeded : [])) {
    if (cols.has(m) && m !== exclude) return m;
  }
  return availableColumns.find((c) => c !== exclude) || null;
}

// ─── Template builder ─────────────────────────────────────────────────────────

/**
 * Validate a candidate has enough data to be useful.
 * Returns null (drop it) if the chart would be empty.
 */
function buildTemplate(index, chartType, description, chartData) {
  if (!chartData) return null;
  if (["bar", "line", "area", "stacked_bar"].includes(chartType)) {
    if (!Array.isArray(chartData.labels) || chartData.labels.length < 1) return null;
    if (!Array.isArray(chartData.series) || !chartData.series.length) return null;
  }
  if (["grouped_bar", "multi_line"].includes(chartType)) {
    if (!Array.isArray(chartData.labels) || chartData.labels.length < 1) return null;
    if (!Array.isArray(chartData.series) || chartData.series.length < 1) return null;
  }
  if (chartType === "scatter") {
    if (!Array.isArray(chartData.points) || chartData.points.length < 2) return null;
  }
  if (chartType === "pie") {
    if (!Array.isArray(chartData.slices) || chartData.slices.length < 2) return null;
  }
  if (chartType === "gauge") {
    if (chartData.value == null || chartData.max == null) return null;
  }
  if (["list_summary", "composed_summary"].includes(chartType)) {
    const hasCards = Array.isArray(chartData.cards) && chartData.cards.length > 0;
    const hasItems = Array.isArray(chartData.items) && chartData.items.length > 0;
    if (!hasCards && !hasItems) return null;
  }
  return { index, chart_type: chartType, description, chart_data: chartData };
}

// ─── Per-stage-type builders ──────────────────────────────────────────────────

function buildOverviewTemplates(rows, metricsNeeded, availableColumns) {
  const results = [];
  const metrics = metricsNeeded.filter((m) => availableColumns.includes(m)).slice(0, 4);
  if (!metrics.length) return results;

  // Primary: bar chart of daily values for the first metric
  const primary = metrics[0];
  const { labels, values } = extractDailySeries(rows, primary);
  if (labels.length >= 1) {
    results.push(buildTemplate(0, "bar",
      `${formatMetricName(primary)} — overview`,
      {
        labels,
        series: [{ name: formatMetricName(primary), data: values }],
        unit: deriveUnit(primary),
      }
    ));
  }

  // Alternate: list_summary of recent metric values as cards
  const { cards, items } = extractListSummaryCards(rows, metrics);
  if (cards.length) {
    results.push(buildTemplate(1, "list_summary",
      "A summary of your most recent health metrics",
      { cards, items }
    ));
  }

  return results.filter(Boolean);
}

function buildTrendTemplates(rows, metricsNeeded, availableColumns) {
  const results = [];
  const primary = pickPrimaryMetric(metricsNeeded, availableColumns);
  if (!primary) return results;

  const { labels, values } = extractDailySeries(rows, primary);
  if (labels.length < 2) return results;
  const avg = computeAverage(rows, primary);
  const unit = deriveUnit(primary);

  results.push(buildTemplate(0, "line",
    `${formatMetricName(primary)} trend over time`,
    {
      labels,
      series: [{ name: formatMetricName(primary), data: values }],
      ...(avg != null ? { reference_line: { value: avg, label: "Average" } } : {}),
      unit,
    }
  ));

  results.push(buildTemplate(1, "area",
    `${formatMetricName(primary)} trend (shaded area)`,
    { labels, series: [{ name: formatMetricName(primary), data: values }], unit }
  ));

  return results.filter(Boolean);
}

function buildComparisonTemplates(rows, metricsNeeded, availableColumns) {
  const results = [];
  const primary = pickPrimaryMetric(metricsNeeded, availableColumns);
  if (!primary) return results;

  const { labels, series } = extractComparisonSeries(rows, primary);
  if (labels.length >= 2) {
    results.push(buildTemplate(0, "grouped_bar",
      `${formatMetricName(primary)} — current period vs previous period`,
      { labels, series, unit: deriveUnit(primary) }
    ));
  }

  // multi_line with a second metric as alternate
  const secondary = pickSecondaryMetric(metricsNeeded, availableColumns, primary);
  if (secondary) {
    const { labels: ml, series: mls } = extractMultiMetricSeries(rows, [primary, secondary]);
    if (ml.length >= 2) {
      results.push(buildTemplate(1, "multi_line",
        `${formatMetricName(primary)} and ${formatMetricName(secondary)} over time`,
        { labels: ml, series: mls }
      ));
    }
  }

  return results.filter(Boolean);
}

function buildRelationshipTemplates(rows, metricsNeeded, availableColumns) {
  const results = [];
  const primary = pickPrimaryMetric(metricsNeeded, availableColumns);
  const secondary = pickSecondaryMetric(metricsNeeded, availableColumns, primary);
  if (!primary || !secondary) return results;

  // Grouped bar: both metrics side-by-side per day (easier to read than scatter)
  const { labels, series } = extractMultiMetricSeries(rows, [primary, secondary]);
  if (labels.length >= 2) {
    results.push(buildTemplate(0, "grouped_bar",
      `${formatMetricName(primary)} alongside ${formatMetricName(secondary)} — each day`,
      { labels, series }
    ));
  }

  // Scatter: each dot is one day
  const scatter = extractScatterPoints(rows, primary, secondary);
  if (scatter.points.length >= 3) {
    results.push(buildTemplate(1, "scatter",
      `${formatMetricName(primary)} vs ${formatMetricName(secondary)} — each dot is one day`,
      scatter
    ));
  }

  return results.filter(Boolean);
}

function buildTakeawayTemplates(rows, metricsNeeded, availableColumns) {
  const results = [];
  const primary = pickPrimaryMetric(metricsNeeded, availableColumns);
  if (!primary) return results;

  const { labels, values } = extractDailySeries(rows, primary);
  if (labels.length >= 1) {
    const avg = computeAverage(rows, primary);
    results.push(buildTemplate(0, "bar",
      `${formatMetricName(primary)} — daily values vs the average`,
      {
        labels,
        series: [{ name: formatMetricName(primary), data: values }],
        ...(avg != null ? { reference_line: { value: avg, label: "Avg" } } : {}),
        unit: deriveUnit(primary),
      }
    ));
  }

  // Alternate: gauge of the primary metric value
  const gauge = extractGaugeValue(rows, primary, null);
  if (gauge && gauge.value != null && gauge.max != null) {
    results.push(buildTemplate(1, "gauge",
      `Your latest ${formatMetricName(primary)} reading`,
      gauge
    ));
  }

  return results.filter(Boolean);
}

function buildGoalProgressTemplates(rows, metricsNeeded, availableColumns) {
  const results = [];
  const primary = pickPrimaryMetric(metricsNeeded, availableColumns);
  if (!primary) return results;

  const gauge = extractGaugeValue(rows, primary, null);
  results.push(buildTemplate(0, "gauge",
    `${formatMetricName(primary)} — progress toward your goal`,
    gauge
  ));

  const { labels, values } = extractDailySeries(rows, primary);
  if (labels.length >= 2) {
    results.push(buildTemplate(1, "bar",
      `${formatMetricName(primary)} — daily progress`,
      {
        labels,
        series: [{ name: formatMetricName(primary), data: values }],
        goal_line: gauge.max,
        unit: gauge.unit,
      }
    ));
  }

  return results.filter(Boolean);
}

function buildIntradayTemplates(rows, metricsNeeded, availableColumns) {
  const results = [];
  const primary = pickPrimaryMetric(metricsNeeded, availableColumns);
  if (!primary) return results;

  const { labels, values } = extractDailySeries(rows, primary);
  if (labels.length < 2) return results;
  const unit = deriveUnit(primary);

  results.push(buildTemplate(0, "area",
    `${formatMetricName(primary)} throughout the day`,
    { labels, series: [{ name: formatMetricName(primary), data: values }], unit }
  ));
  results.push(buildTemplate(1, "bar",
    `${formatMetricName(primary)} by time of day`,
    { labels, series: [{ name: formatMetricName(primary), data: values }], unit }
  ));

  return results.filter(Boolean);
}

function buildSleepDetailTemplates(rows, metricsNeeded, availableColumns, rawFitbitCache) {
  const results = [];

  // Attempt to build a sleep stage pie from rawFitbitCache
  const stageSlices = extractSleepStagesFromCache(rawFitbitCache);
  if (stageSlices.length >= 2) {
    results.push(buildTemplate(0, "pie",
      "How your sleep time was divided across stages last night",
      { slices: stageSlices }
    ));
  }

  // Fallback: sleep_minutes trend as bar chart
  const sleepMetric = metricsNeeded.find((m) => availableColumns.includes(m) && m.startsWith("sleep"))
    || pickPrimaryMetric(metricsNeeded, availableColumns);
  if (sleepMetric) {
    const { labels, values } = extractDailySeries(rows, sleepMetric);
    if (labels.length >= 2) {
      results.push(buildTemplate(results.length, "bar",
        `${formatMetricName(sleepMetric)} each night`,
        { labels, series: [{ name: formatMetricName(sleepMetric), data: values }], unit: deriveUnit(sleepMetric) }
      ));
    }
  }

  return results.filter(Boolean);
}

function buildHeartRecoveryTemplates(rows, metricsNeeded, availableColumns) {
  const results = [];
  const hrPriority = ["resting_hr", "hrv", "heart_intraday"];
  const primary = hrPriority.find((m) => availableColumns.includes(m))
    || pickPrimaryMetric(metricsNeeded, availableColumns);
  if (!primary) return results;

  const { labels, values } = extractDailySeries(rows, primary);
  if (labels.length >= 2) {
    const avg = computeAverage(rows, primary);
    results.push(buildTemplate(0, "line",
      `${formatMetricName(primary)} trend — lower is generally better`,
      {
        labels,
        series: [{ name: formatMetricName(primary), data: values }],
        ...(avg != null ? { reference_line: { value: avg, label: "Avg" } } : {}),
        unit: deriveUnit(primary),
      }
    ));
  }

  const gauge = extractGaugeValue(rows, primary, null);
  if (gauge.value) {
    results.push(buildTemplate(results.length, "gauge",
      `Your latest ${formatMetricName(primary)} reading`,
      gauge
    ));
  }

  return results.filter(Boolean);
}

// ─── Sleep stage extraction from rawFitbitCache ───────────────────────────────

/**
 * Parse sleep stage minutes from the rawFitbitCache sleep endpoint response.
 * Returns pie slices like [{ name: "Deep Sleep", value: 90 }, ...].
 */
function extractSleepStagesFromCache(rawFitbitCache) {
  const slices = [];
  try {
    if (!rawFitbitCache || typeof rawFitbitCache !== "object") return slices;
    const sleepKey = Object.keys(rawFitbitCache).find(
      (k) => k.includes("sleep") && (k.includes("single") || k.includes("date"))
    );
    if (!sleepKey) return slices;
    const sleepRaw = rawFitbitCache[sleepKey];
    const sleepArr = Array.isArray(sleepRaw?.sleep) ? sleepRaw.sleep : [];
    const mainSleep = sleepArr.find((s) => s.isMainSleep) || sleepArr[0];
    const summary = mainSleep?.levels?.summary;
    if (!summary) return slices;
    const stageMap = { deep: "Deep Sleep", light: "Light Sleep", rem: "REM Sleep", wake: "Awake" };
    for (const [key, label] of Object.entries(stageMap)) {
      const minutes = toNumber(summary[key]?.minutes);
      if (minutes != null && minutes > 0) slices.push({ name: label, value: minutes });
    }
  } catch (_) {}
  return slices;
}

// ─── Stage type → builder dispatch ───────────────────────────────────────────

const STAGE_TYPE_BUILDERS = {
  overview:           buildOverviewTemplates,
  trend:              buildTrendTemplates,
  comparison:         buildComparisonTemplates,
  relationship:       buildRelationshipTemplates,
  takeaway:           buildTakeawayTemplates,
  anomaly:            buildTakeawayTemplates,    // reuses takeaway (bar with avg reference)
  goal_progress:      buildGoalProgressTemplates,
  intraday_breakdown: buildIntradayTemplates,
  sleep_detail:       buildSleepDetailTemplates,
  heart_recovery:     buildHeartRecoveryTemplates,
};

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Build template candidates for the current stage.
 *
 * @param {object} opts
 * @param {object[]}   opts.normalizedTable   - rows from bundle memory
 * @param {object}     opts.plannerOutput     - { metrics_needed, candidate_stage_types, time_scope, ... }
 * @param {number}     opts.stageIndex        - which stage we are generating (0-based)
 * @param {string[]}   opts.previousStageTypes - stage types already shown (to avoid exact repeats)
 * @param {object|null} opts.rawFitbitCache   - raw Fitbit endpoint responses (for sleep stages)
 *
 * @returns {{ index: number, chart_type: string, description: string, chart_data: object }[]}
 */
function buildTemplatesForStage({
  normalizedTable = [],
  plannerOutput = {},
  stageIndex = 0,
  previousStageTypes = [],
  rawFitbitCache = null,
} = {}) {
  const rows = Array.isArray(normalizedTable) ? normalizedTable : [];
  const availableColumns = getAvailableColumns(rows);

  const metricsNeeded = Array.isArray(plannerOutput?.metrics_needed)
    ? plannerOutput.metrics_needed
    : Array.isArray(plannerOutput?.metricsNeeded)
      ? plannerOutput.metricsNeeded
      : [];

  const candidateStageTypes = Array.isArray(plannerOutput?.candidate_stage_types)
    ? plannerOutput.candidate_stage_types
    : Array.isArray(plannerOutput?.candidateStageTypes)
      ? plannerOutput.candidateStageTypes
      : [];

  // Resolve which stage type applies to this index
  const stageType = candidateStageTypes[stageIndex] || candidateStageTypes[0] || "overview";

  templateLog("building templates", {
    stageIndex,
    stageType,
    metricsNeeded,
    availableColumns,
    rowCount: rows.length,
  });

  if (!rows.length || !availableColumns.length) {
    templateLog("no data available → returning empty candidate list");
    return [];
  }

  const builder = STAGE_TYPE_BUILDERS[stageType] || buildOverviewTemplates;

  let candidates = [];
  try {
    candidates = builder(rows, metricsNeeded, availableColumns, rawFitbitCache);
  } catch (err) {
    templateLog("builder threw → fallback to list_summary", { stageType, error: String(err?.message || err) });
    candidates = [];
  }

  // If primary builder returned nothing, fall back to overview/takeaway
  if (!candidates.length && stageType !== "overview") {
    templateLog("primary builder returned no candidates → falling back to overview templates");
    try {
      candidates = buildOverviewTemplates(rows, metricsNeeded, availableColumns);
    } catch (_) {}
  }

  // Last resort: list_summary of available columns
  if (!candidates.length) {
    const fallbackMetrics = availableColumns.slice(0, 4);
    const { cards, items } = extractListSummaryCards(rows, fallbackMetrics);
    if (cards.length) {
      candidates = [buildTemplate(0, "list_summary", "Your health data at a glance", { cards, items })].filter(Boolean);
    }
  }

  // Re-index and cap to MAX_CANDIDATES
  const final = candidates
    .filter(Boolean)
    .slice(0, MAX_CANDIDATES)
    .map((c, i) => ({ ...c, index: i }));

  templateLog(`built ${final.length} template(s) for stageType=${stageType}`, {
    types: final.map((c) => c.chart_type),
  });

  return final;
}

module.exports = { buildTemplatesForStage };
