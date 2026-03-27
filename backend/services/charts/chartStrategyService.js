/**
 * backend/services/charts/chartStrategyService.js
 *
 * Replaces the fixed template builder with a dynamic strategy system.
 *
 * Instead of pre-building 2 templates from a fixed stageType mapping, this service:
 *   1. Inspects available data across sub-analyses and evidence
 *   2. Generates 3-5 viable chart strategies with descriptions
 *   3. After GPT picks a strategy_id, deterministically builds chart_data
 *
 * The LLM gets freedom to choose the *right* visualization, but chart data
 * is still built deterministically by the backend. No hallucinated numbers.
 */

"use strict";

const {
  extractDailySeries,
  extractMultiMetricSeries,
  extractScatterPoints,
  extractComparisonSeries,
  extractGaugeValue,
  extractListSummaryCards,
  extractHeatmapData,
  extractDonutData,
  computeAverage,
  formatMetricName,
  deriveUnit,
  deriveMax,
} = require("./metricExtractor");

const { computeDayOfWeekPattern } = require("../analytics/evidenceComputer");

const STRATEGY_DEBUG = process.env.QNA_STRATEGY_DEBUG !== "false";

function strategyLog(msg, data = null) {
  if (!STRATEGY_DEBUG) return;
  if (data == null) return console.log(`[ChartStrategyService] ${msg}`);
  console.log(`[ChartStrategyService] ${msg}`, data);
}

function toNumber(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getMetricColumns(rows) {
  if (!Array.isArray(rows) || !rows.length) return [];
  return Object.keys(rows[0] || {}).filter((k) => k !== "timestamp");
}

// ─── Strategy generators ──────────────────────────────────────────────────────

/**
 * Generate viable strategies for a stage based on available data and evidence.
 *
 * @param {object} opts
 * @param {object}   opts.stageSpec       - from planner: { sub_analysis_ids, visualization_intent, chartType, ... }
 * @param {object}   opts.multiWindowData - { [saId]: { normalizedTable, metrics_needed, window, ... } }
 * @param {object}   opts.evidenceBundle  - from evidenceComputer: { sub_analyses, cross_analysis }
 * @param {string[]} opts.previousChartTypes - chart types already used in earlier stages
 * @returns {{ strategy_id, chart_type, description, data_sources, metrics }[]}
 */
function generateViableStrategies({ stageSpec = {}, multiWindowData = {}, evidenceBundle = {}, previousChartTypes = [] } = {}) {
  const strategies = [];
  const saIds = Array.isArray(stageSpec?.sub_analysis_ids) ? stageSpec.sub_analysis_ids : Object.keys(multiWindowData).slice(0, 2);
  const intent = String(stageSpec?.visualization_intent || "").toLowerCase();
  const hintChart = String(stageSpec?.chartType || "").toLowerCase();

  // Collect all available rows and metrics across referenced sub-analyses
  const allRows = [];
  const allMetrics = new Set();
  for (const saId of saIds) {
    const sa = multiWindowData[saId];
    if (!sa?.normalizedTable) continue;
    allRows.push(...sa.normalizedTable);
    for (const col of getMetricColumns(sa.normalizedTable)) allMetrics.add(col);
  }

  const metrics = [...allMetrics];
  const primaryMetric = metrics[0] || null;
  const secondaryMetric = metrics[1] || null;
  const usedTypes = new Set(previousChartTypes);

  if (!primaryMetric) {
    strategies.push({
      strategy_id: "fallback_list",
      chart_type: "list_summary",
      description: "No chart data available — show a text summary",
      data_sources: saIds,
      metrics: [],
    });
    return strategies;
  }

  // ── Comparison strategies (multiple sub-analyses with same metric) ──────
  if (saIds.length >= 2) {
    const saLabels = saIds.map((id) => multiWindowData[id]?.label || id);
    const sharedMetrics = metrics.filter((m) =>
      saIds.every((id) => getMetricColumns(multiWindowData[id]?.normalizedTable || []).includes(m))
    );

    if (sharedMetrics.length > 0) {
      strategies.push({
        strategy_id: "grouped_bar_cross_period",
        chart_type: "grouped_bar",
        description: `Side-by-side bars comparing ${saLabels.join(" vs ")} for ${sharedMetrics.map(formatMetricName).join(", ")}`,
        data_sources: saIds,
        metrics: sharedMetrics.slice(0, 4),
      });
    }

    if (sharedMetrics.length > 0) {
      strategies.push({
        strategy_id: "bar_with_reference",
        chart_type: "bar",
        description: `${formatMetricName(sharedMetrics[0])} values as bars with average reference line`,
        data_sources: saIds,
        metrics: [sharedMetrics[0]],
      });
    }
  }

  // ── Single sub-analysis strategies ─────────────────────────────────────
  const primarySaId = saIds[0];
  const primaryRows = multiWindowData[primarySaId]?.normalizedTable || [];
  const primaryCols = getMetricColumns(primaryRows);

  // Trend line
  if (primaryRows.length >= 2 && primaryMetric) {
    strategies.push({
      strategy_id: "line_trend",
      chart_type: "line",
      description: `${formatMetricName(primaryMetric)} trend over time with average reference`,
      data_sources: [primarySaId],
      metrics: [primaryMetric],
    });
  }

  // Multi-line for 2+ metrics
  if (primaryRows.length >= 2 && secondaryMetric) {
    strategies.push({
      strategy_id: "multi_line_comparison",
      chart_type: "multi_line",
      description: `${formatMetricName(primaryMetric)} and ${formatMetricName(secondaryMetric)} trends together`,
      data_sources: [primarySaId],
      metrics: [primaryMetric, secondaryMetric],
    });
  }

  // Bar chart
  if (primaryRows.length >= 1 && primaryMetric) {
    strategies.push({
      strategy_id: "bar_daily",
      chart_type: "bar",
      description: `Daily ${formatMetricName(primaryMetric)} values`,
      data_sources: [primarySaId],
      metrics: [primaryMetric],
    });
  }

  // Area chart
  if (primaryRows.length >= 2 && primaryMetric) {
    strategies.push({
      strategy_id: "area_trend",
      chart_type: "area",
      description: `${formatMetricName(primaryMetric)} trend as shaded area`,
      data_sources: [primarySaId],
      metrics: [primaryMetric],
    });
  }

  // Sleep stage stacked bar
  const SLEEP_STAGE_COLS = ["sleep_deep", "sleep_light", "sleep_rem", "sleep_awake"];
  const availableStages = SLEEP_STAGE_COLS.filter((m) => primaryCols.includes(m));
  if (availableStages.length >= 2) {
    strategies.push({
      strategy_id: "stacked_bar_sleep_stages",
      chart_type: "stacked_bar",
      description: "Sleep stage breakdown each night (deep, light, REM, awake)",
      data_sources: [primarySaId],
      metrics: availableStages,
    });
  }

  // Pie for sleep stage composition (single day or latest)
  if (availableStages.length >= 2 && primaryRows.length >= 1) {
    strategies.push({
      strategy_id: "pie_sleep_composition",
      chart_type: "pie",
      description: "How sleep time was divided across stages",
      data_sources: [primarySaId],
      metrics: availableStages,
    });
  }

  // Scatter for relationship
  if (primaryRows.length >= 3 && primaryMetric && secondaryMetric) {
    strategies.push({
      strategy_id: "scatter_relationship",
      chart_type: "scatter",
      description: `${formatMetricName(primaryMetric)} vs ${formatMetricName(secondaryMetric)} — each dot is one day`,
      data_sources: [primarySaId],
      metrics: [primaryMetric, secondaryMetric],
    });
  }

  // Grouped bar for relationship (easier for older adults)
  if (primaryRows.length >= 2 && primaryMetric && secondaryMetric) {
    strategies.push({
      strategy_id: "grouped_bar_relationship",
      chart_type: "grouped_bar",
      description: `${formatMetricName(primaryMetric)} alongside ${formatMetricName(secondaryMetric)} each day`,
      data_sources: [primarySaId],
      metrics: [primaryMetric, secondaryMetric],
    });
  }

  // Gauge for latest value
  if (primaryMetric) {
    strategies.push({
      strategy_id: "gauge_latest",
      chart_type: "gauge",
      description: `Your latest ${formatMetricName(primaryMetric)} reading as a progress dial`,
      data_sources: [primarySaId],
      metrics: [primaryMetric],
    });
  }

  // Radar for multi-metric overview
  if (metrics.length >= 3 && primaryRows.length >= 1) {
    strategies.push({
      strategy_id: "radar_overview",
      chart_type: "radar",
      description: "Multi-dimensional health overview at a glance",
      data_sources: [primarySaId],
      metrics: metrics.slice(0, 6),
    });
  }

  // Heatmap — day-of-week pattern (1+ metric, 7+ rows)
  if (primaryRows.length >= 7 && primaryMetric) {
    strategies.push({
      strategy_id: "heatmap_day_of_week",
      chart_type: "heatmap",
      description: `${formatMetricName(primaryMetric)} pattern by day of week — which days are consistently higher or lower`,
      data_sources: [primarySaId],
      metrics: [primaryMetric],
    });
  }

  // Heatmap — multi-metric (3+ metrics, 7+ rows)
  if (primaryRows.length >= 7 && metrics.length >= 3) {
    strategies.push({
      strategy_id: "heatmap_multi_metric",
      chart_type: "heatmap",
      description: "Multiple health metrics by day of week — spot which days your health metrics peak or dip",
      data_sources: [primarySaId],
      metrics: metrics.slice(0, 4),
    });
  }

  // Donut — headline value with breakdown ring
  if (primaryMetric && primaryRows.length >= 1) {
    strategies.push({
      strategy_id: "donut_headline",
      chart_type: "donut",
      description: `Your latest ${formatMetricName(primaryMetric)} reading highlighted at center, with context breakdown around the ring`,
      data_sources: [primarySaId],
      metrics: [primaryMetric],
    });
  }

  // Bar anomaly highlight — daily values with anomalous readings flagged
  const hasAnomalies = (() => {
    const subAnalyses = evidenceBundle?.sub_analyses || {};
    for (const saEvidence of Object.values(subAnalyses)) {
      for (const metricEvidence of Object.values(saEvidence?.metrics || {})) {
        if (Array.isArray(metricEvidence?.anomalies) && metricEvidence.anomalies.length > 0) return true;
      }
    }
    return false;
  })();
  if (hasAnomalies && primaryMetric && primaryRows.length >= 1) {
    strategies.push({
      strategy_id: "bar_anomaly_highlight",
      chart_type: "bar",
      description: `Daily ${formatMetricName(primaryMetric)} values with unusual readings marked — anomalous days stand out`,
      data_sources: [primarySaId],
      metrics: [primaryMetric],
    });
  }

  // List summary
  if (metrics.length >= 1) {
    strategies.push({
      strategy_id: "list_summary_overview",
      chart_type: "list_summary",
      description: "A summary of your most recent health metrics as cards",
      data_sources: [primarySaId],
      metrics: metrics.slice(0, 4),
    });
  }

  // Composed summary
  if (metrics.length >= 2) {
    strategies.push({
      strategy_id: "composed_summary",
      chart_type: "composed_summary",
      description: "Overview dashboard with key metrics and observations",
      data_sources: [primarySaId],
      metrics: metrics.slice(0, 4),
    });
  }

  // ── Rank strategies: enforce planner's chartType, avoid repeats ─────────
  // The planner decides which chart type each stage should use. The executor
  // should respect that decision. Matching strategies are partitioned first;
  // non-matching types are only available as fallbacks.
  const rankFallbacks = (a, b) => {
    const aUsed = usedTypes.has(a.chart_type) ? 1 : 0;
    const bUsed = usedTypes.has(b.chart_type) ? 1 : 0;
    const aText = (a.chart_type === "list_summary" || a.chart_type === "composed_summary") ? 3 : 0;
    const bText = (b.chart_type === "list_summary" || b.chart_type === "composed_summary") ? 3 : 0;
    return (aUsed + aText) - (bUsed + bText);
  };

  if (hintChart) {
    const matching = strategies.filter((s) => s.chart_type === hintChart);
    const fallbacks = strategies.filter((s) => s.chart_type !== hintChart);
    fallbacks.sort(rankFallbacks);
    strategies.length = 0;
    strategies.push(...matching, ...fallbacks);
  } else {
    strategies.sort(rankFallbacks);
  }

  const result = strategies.slice(0, 6);
  strategyLog(`generated ${result.length} strategies`, {
    ids: result.map((s) => s.strategy_id),
    intent,
    hintChart,
  });

  return result;
}

// ─── Chart data builders (deterministic) ──────────────────────────────────────

/**
 * Build chart_data from the selected strategy. All data is deterministic.
 *
 * @param {string} strategyId
 * @param {object} multiWindowData
 * @param {object} evidenceBundle
 * @param {object[]} viableStrategies - the strategies list (to find the selected one)
 * @returns {{ chart_type, chart_data }} or null
 */
function buildChartFromStrategy(strategyId, multiWindowData, evidenceBundle, viableStrategies = []) {
  const strategy = viableStrategies.find((s) => s.strategy_id === strategyId) || viableStrategies[0];
  if (!strategy) return null;

  const saIds = strategy.data_sources || [];
  const metrics = strategy.metrics || [];
  const chartType = strategy.chart_type;

  // Merge rows from all referenced sub-analyses
  const allRows = [];
  for (const saId of saIds) {
    const sa = multiWindowData[saId];
    if (!sa?.normalizedTable) continue;
    allRows.push(...sa.normalizedTable);
  }

  // Sort by timestamp
  allRows.sort((a, b) => String(a?.timestamp || "") < String(b?.timestamp || "") ? -1 : 1);

  const primaryMetric = metrics[0] || getMetricColumns(allRows)[0];
  const secondaryMetric = metrics[1] || null;

  strategyLog("building chart from strategy", { strategyId, chartType, metrics, rowCount: allRows.length });

  switch (chartType) {
    case "bar": {
      const { labels, values } = extractDailySeries(allRows, primaryMetric);
      const avg = computeAverage(allRows, primaryMetric);

      // For bar_anomaly_highlight: collect anomalous dates and mark them
      let markPoints = undefined;
      if (strategyId === "bar_anomaly_highlight") {
        const anomalyDates = new Set();
        const subAnalyses = evidenceBundle?.sub_analyses || {};
        for (const saEvidence of Object.values(subAnalyses)) {
          const metricEvidence = saEvidence?.metrics?.[primaryMetric];
          if (Array.isArray(metricEvidence?.anomalies)) {
            for (const anomaly of metricEvidence.anomalies) {
              if (anomaly.date) anomalyDates.add(String(anomaly.date).slice(0, 10));
            }
          }
        }
        if (anomalyDates.size > 0) {
          // Build markPoints array: { coord: [labelIndex, value], name: "Unusual" }
          markPoints = [];
          allRows
            .sort((a, b) => String(a?.timestamp || "") < String(b?.timestamp || "") ? -1 : 1)
            .forEach((row, idx) => {
              const dateKey = String(row?.timestamp || "").slice(0, 10);
              if (anomalyDates.has(dateKey)) {
                const val = toNumber(row?.[primaryMetric]);
                if (val !== null) markPoints.push({ coord: [idx, val], name: "Unusual" });
              }
            });
        }
      }

      return {
        chart_type: "bar",
        chart_data: {
          labels,
          series: [{ name: formatMetricName(primaryMetric), data: values }],
          ...(avg != null ? { reference_line: { value: avg, label: "Average" } } : {}),
          ...(markPoints ? { markPoints } : {}),
          unit: deriveUnit(primaryMetric),
        },
      };
    }

    case "grouped_bar": {
      if (strategyId === "grouped_bar_cross_period" && saIds.length >= 2) {
        return buildCrossPeriodGroupedBar(saIds, metrics, multiWindowData);
      }
      const targetMetrics = secondaryMetric ? [primaryMetric, secondaryMetric] : [primaryMetric];
      const { labels, series } = extractMultiMetricSeries(allRows, targetMetrics);
      return { chart_type: "grouped_bar", chart_data: { labels, series } };
    }

    case "line": {
      const { labels, values } = extractDailySeries(allRows, primaryMetric);
      const avg = computeAverage(allRows, primaryMetric);
      return {
        chart_type: "line",
        chart_data: {
          labels,
          series: [{ name: formatMetricName(primaryMetric), data: values }],
          ...(avg != null ? { reference_line: { value: avg, label: "Average" } } : {}),
          unit: deriveUnit(primaryMetric),
        },
      };
    }

    case "multi_line": {
      const targetMetrics = metrics.slice(0, 4);
      const { labels, series } = extractMultiMetricSeries(allRows, targetMetrics);
      return { chart_type: "multi_line", chart_data: { labels, series } };
    }

    case "area": {
      const { labels, values } = extractDailySeries(allRows, primaryMetric);
      return {
        chart_type: "area",
        chart_data: {
          labels,
          series: [{ name: formatMetricName(primaryMetric), data: values }],
          unit: deriveUnit(primaryMetric),
        },
      };
    }

    case "stacked_bar": {
      const stackMetrics = metrics.length >= 2 ? metrics : [primaryMetric];
      const { labels, series } = extractMultiMetricSeries(allRows, stackMetrics);
      return { chart_type: "stacked_bar", chart_data: { labels, series, unit: "min" } };
    }

    case "pie": {
      // Use latest row for single-night pie
      const lastRow = allRows[allRows.length - 1] || {};
      const slices = metrics
        .map((m) => ({ name: formatMetricName(m), value: toNumber(lastRow[m]) }))
        .filter((s) => s.value != null && s.value > 0);
      if (slices.length < 2) return buildFallbackChart(allRows, primaryMetric);
      return { chart_type: "pie", chart_data: { slices } };
    }

    case "scatter": {
      if (!primaryMetric || !secondaryMetric) return buildFallbackChart(allRows, primaryMetric);
      const scatter = extractScatterPoints(allRows, primaryMetric, secondaryMetric);
      return { chart_type: "scatter", chart_data: scatter };
    }

    case "gauge": {
      const gauge = extractGaugeValue(allRows, primaryMetric, null);
      return { chart_type: "gauge", chart_data: gauge };
    }

    case "radar": {
      const RADAR_MAX_VALUES = {
        steps: 15000, calories: 3000, distance: 10, floors: 20,
        sleep_minutes: 600, sleep_deep: 120, sleep_light: 240, sleep_rem: 120,
        sleep_awake: 60, sleep_efficiency: 100, resting_hr: 100, hrv: 100,
        breathing_rate: 25, spo2: 100,
      };
      const available = metrics.filter((m) => allRows.some((r) => toNumber(r[m]) !== null));
      if (available.length < 3) return buildFallbackChart(allRows, primaryMetric);
      const indicators = available.map((m) => ({
        name: formatMetricName(m),
        max: RADAR_MAX_VALUES[m] || Math.max(1, (computeAverage(allRows, m) || 0) * 1.5),
      }));
      const lastRow = [...allRows].reverse().find((r) => available.some((m) => toNumber(r[m]) !== null));
      const values = available.map((m) => toNumber(lastRow?.[m]) || 0);
      return {
        chart_type: "radar",
        chart_data: { indicators, series: [{ name: "Your stats", data: values }] },
      };
    }

    case "heatmap": {
      // Determine which metrics to use and the x-mode
      const heatmapMetrics = metrics.length >= 1 ? metrics.slice(0, 4) : (primaryMetric ? [primaryMetric] : []);
      if (!heatmapMetrics.length) return buildFallbackChart(allRows, primaryMetric);
      const xMode = strategyId === "heatmap_multi_metric" ? "day_of_week" : "day_of_week";
      const { xLabels, yLabels, data } = extractHeatmapData(allRows, heatmapMetrics, xMode);
      if (!data.length) return buildFallbackChart(allRows, primaryMetric);
      return {
        chart_type: "heatmap",
        chart_data: {
          xLabels,
          yLabels,
          data,
          // Also provide axis-named fields for ECharts compatibility
          xAxis: { data: xLabels },
          yAxis: { data: yLabels },
          series: [{ data }],
          unit: deriveUnit(heatmapMetrics[0]),
        },
      };
    }

    case "donut": {
      // Use sleep stage metrics as slices if available, otherwise single-metric center
      const SLEEP_STAGE_COLS = ["sleep_deep", "sleep_light", "sleep_rem", "sleep_awake"];
      const availableStages = SLEEP_STAGE_COLS.filter((m) => allRows.some((r) => toNumber(r[m]) !== null));
      const sliceMetrics = availableStages.length >= 2
        ? availableStages
        : (metrics.length >= 2 ? metrics.slice(0, 4) : null);
      const { slices, centerValue, centerLabel, unit } = extractDonutData(allRows, primaryMetric, sliceMetrics);
      if (!slices.length && centerValue == null) return buildFallbackChart(allRows, primaryMetric);
      return {
        chart_type: "donut",
        chart_data: {
          slices: slices.length ? slices : [{ name: centerLabel, value: centerValue }],
          centerValue,
          centerLabel,
          unit,
        },
      };
    }

    case "list_summary":
    case "composed_summary": {
      const { cards, items } = extractListSummaryCards(allRows, metrics.slice(0, 4));
      return { chart_type: chartType, chart_data: { cards, items } };
    }

    default:
      return buildFallbackChart(allRows, primaryMetric);
  }
}

function buildCrossPeriodGroupedBar(saIds, metrics, multiWindowData) {
  const primaryMetric = metrics[0];
  if (!primaryMetric) return null;

  const labels = [];
  const seriesMap = {};

  for (const saId of saIds) {
    const sa = multiWindowData[saId];
    if (!sa?.normalizedTable) continue;
    const saLabel = sa.label || saId;

    for (const metric of metrics.slice(0, 4)) {
      if (!seriesMap[metric]) seriesMap[metric] = { name: formatMetricName(metric), data: [] };
    }

    // For each sub-analysis, compute the average of the primary metric
    const avg = computeAverage(sa.normalizedTable, primaryMetric);
    if (!labels.includes(saLabel)) labels.push(saLabel);

    for (const metric of metrics.slice(0, 4)) {
      const metricAvg = computeAverage(sa.normalizedTable, metric);
      seriesMap[metric].data.push(metricAvg != null ? metricAvg : 0);
    }
  }

  const series = Object.values(seriesMap);
  return { chart_type: "grouped_bar", chart_data: { labels, series } };
}

function buildFallbackChart(rows, primaryMetric) {
  if (!primaryMetric) {
    return { chart_type: "list_summary", chart_data: { cards: [], items: ["No data available"] } };
  }
  const { labels, values } = extractDailySeries(rows, primaryMetric);
  return {
    chart_type: "bar",
    chart_data: {
      labels,
      series: [{ name: formatMetricName(primaryMetric), data: values }],
      unit: deriveUnit(primaryMetric),
    },
  };
}

module.exports = {
  generateViableStrategies,
  buildChartFromStrategy,
};
