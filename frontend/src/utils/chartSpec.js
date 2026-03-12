/**
 * frontend/src/utils/chartSpec.js
 *
 * Frontend-side chart_spec guardrail for deterministic rendering.
 */

import { applyPremiumHealthTheme } from "./echartsTheme";

const SUPPORTED_CHART_TYPES = new Set([
  "bar",
  "grouped_bar",
  "line",
  "multi_line",
  "stacked_bar",
  "scatter",
  "area",
  "heatmap",
  "radar",
  "boxplot",
  "timeline",
  "gauge",
  "pie",
  "list_summary",
  "composed_summary",
]);

const MAX_POINTS = 90;
const MAX_TITLE = 80;
const MAX_SUBTITLE = 120;
const MAX_TAKEAWAY = 220;
const MAX_FOLLOW_UP = 4;
const MAX_SERIES = 4;
const MAX_LIST_ITEMS = 8;
const TIME_AXIS_LABEL_RE = /^(?:\d{1,2}:\d{2}(?::\d{2})?|\d{1,2}\s?(?:AM|PM))$/i;
const ZERO_ONLY_LABEL_RE = /^0(?:\.0+)?$/;

const toNum = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const sanitizeText = (value, max = 80, fallback = "") => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : fallback;
};

const sanitizeStringArray = (values, maxItems = MAX_POINTS, maxLen = 24) => {
  if (!Array.isArray(values)) return [];
  return values.map((value) => sanitizeText(value, maxLen, "")).filter(Boolean).slice(0, maxItems);
};

const sanitizeAxisLabels = (values, desiredLength, maxLen = 24) => {
  if (!Array.isArray(values) || !values.length) return [];
  const safeLength = Number.isFinite(desiredLength) && desiredLength > 0
    ? Math.min(MAX_POINTS, desiredLength)
    : Math.min(MAX_POINTS, values.length);
  const labels = values
    .slice(0, safeLength)
    .map((value) => sanitizeText(value, maxLen, ""));
  const hasTimeAxis = labels.filter((label) => TIME_AXIS_LABEL_RE.test(label)).length >= 2;
  const cleaned = labels.map((label) => (hasTimeAxis && ZERO_ONLY_LABEL_RE.test(label) ? "" : label));
  while (cleaned.length < safeLength) cleaned.push("");
  return cleaned;
};

const sanitizeFollowUps = (values) => {
  if (!Array.isArray(values)) return [];
  return values.map((value) => sanitizeText(value, 80, "")).filter(Boolean).slice(0, MAX_FOLLOW_UP);
};

function fallbackChartSpec(title = "Your Health Data", takeaway = "I could not prepare that chart safely.") {
  const safeTitle = sanitizeText(title, MAX_TITLE, "Your Health Data");
  return {
    chart_type: "bar",
    title: safeTitle,
    subtitle: "Last 7 days",
    takeaway: sanitizeText(takeaway, MAX_TAKEAWAY, "I could not prepare that chart safely."),
    highlight: null,
    suggested_follow_up: ["Can you show my last 7 days of steps?"],
    option: applyPremiumHealthTheme({
      tooltip: { trigger: "axis" },
      xAxis: { type: "category", data: ["M", "T", "W", "Th", "F", "Sa", "Su"] },
      yAxis: { type: "value" },
      series: [{ type: "bar", name: "No data", data: [0, 0, 0, 0, 0, 0, 0] }],
    }, { title: safeTitle, chartType: "bar" }),
  };
}

function sanitizeSeries(series = [], type = "line") {
  return (Array.isArray(series) ? series : [])
    .slice(0, MAX_SERIES)
    .map((item, idx) => ({
      type,
      name: sanitizeText(item?.name, 24, `Series ${idx + 1}`),
      stack: sanitizeText(item?.stack, 20, ""),
      itemStyle: item?.itemStyle && typeof item.itemStyle === "object" ? { ...item.itemStyle } : undefined,
      lineStyle: item?.lineStyle && typeof item.lineStyle === "object" ? { ...item.lineStyle } : undefined,
      label: item?.label && typeof item.label === "object" ? { ...item.label } : undefined,
      emphasis: item?.emphasis && typeof item.emphasis === "object" ? { ...item.emphasis } : undefined,
      symbol: sanitizeText(item?.symbol, 24, ""),
      symbolSize: Number.isFinite(Number(item?.symbolSize)) ? Number(item.symbolSize) : undefined,
      showSymbol: typeof item?.showSymbol === "boolean" ? item.showSymbol : undefined,
      smooth: typeof item?.smooth === "boolean" ? item.smooth : undefined,
      barMaxWidth: Number.isFinite(Number(item?.barMaxWidth)) ? Number(item.barMaxWidth) : undefined,
      areaStyle: type === "area" || item?.areaStyle ? { ...(item?.areaStyle || {}), opacity: item?.areaStyle?.opacity ?? 0.16 } : undefined,
      data: (Array.isArray(item?.data) ? item.data : [])
        .slice(0, MAX_POINTS)
        .map((value) => (Array.isArray(value) ? value.map((pair) => toNum(pair, NaN)) : toNum(value, NaN))),
    }))
    .filter((item) => Array.isArray(item.data) && item.data.length);
}

function sanitizeListSummaryOption(rawOption = {}, spec = {}) {
  const items = (Array.isArray(rawOption.items) ? rawOption.items : Array.isArray(spec.items) ? spec.items : [])
    .map((item) => sanitizeText(item, 96, ""))
    .filter(Boolean)
    .slice(0, MAX_LIST_ITEMS);
  const text = items.length ? items.map((item) => `• ${item}`).join("\n") : "• No details available";
  return {
    items,
    graphic: [{
      type: "text",
      left: "5%",
      top: "10%",
      style: {
        text,
        fontSize: 16,
        lineHeight: 28,
        fill: "#1E293B",
      },
    }],
  };
}

function sanitizeGaugeOption(rawOption = {}) {
  const rawSeries = Array.isArray(rawOption.series) ? rawOption.series[0] : {};
  const rawPoint = Array.isArray(rawSeries?.data) ? rawSeries.data[0] : {};
  const max = Math.max(1, toNum(rawSeries?.max ?? rawOption.max, 100));
  const value = Math.max(0, Math.min(max, toNum(rawPoint?.value ?? rawOption.value, 0)));
  return {
    series: [{
      type: "gauge",
      radius: "92%",
      center: ["50%", "55%"],
      min: 0,
      max,
      progress: { show: true, width: 16 },
      axisLine: { lineStyle: { width: 16 } },
      pointer: { show: false },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: { show: false },
      detail: {
        show: true,
        formatter: "{value}",
        fontSize: 26,
        fontWeight: 700,
        offsetCenter: [0, "70%"],
      },
      data: [{ value, name: sanitizeText(rawPoint?.name || rawOption.name, 24, "Progress") }],
    }],
  };
}

function sanitizePieOption(rawOption = {}) {
  const rawData = Array.isArray(rawOption?.series?.[0]?.data) ? rawOption.series[0].data : [];
  const data = rawData
    .map((item, idx) => ({
      name: sanitizeText(item?.name, 24, `Slice ${idx + 1}`),
      value: toNum(item?.value, NaN),
    }))
    .filter((item) => Number.isFinite(item.value))
    .slice(0, MAX_LIST_ITEMS);
  if (!data.length) return null;
  return {
    tooltip: { trigger: "item" },
    legend: { bottom: 0 },
    series: [{ type: "pie", radius: ["40%", "72%"], data }],
  };
}

function sanitizeCartesianOption(rawOption = {}, chartType = "bar") {
  const yAxisName = sanitizeText(rawOption?.yAxis?.name, 20, "");
  const typeMap = {
    bar: "bar",
    grouped_bar: "bar",
    stacked_bar: "bar",
    line: "line",
    multi_line: "line",
    area: "line",
    timeline: "line",
    scatter: "scatter",
  };
  const seriesType = typeMap[chartType] || "bar";
  const rawSeries = Array.isArray(rawOption.series) ? rawOption.series : [];
  const parsedSeries = sanitizeSeries(rawSeries, seriesType);
  if (!parsedSeries.length) return null;
  const maxSeriesLength = Math.min(
    MAX_POINTS,
    Math.max(...parsedSeries.map((item) => (Array.isArray(item.data) ? item.data.length : 0)))
  );
  const rawXAxis = rawOption?.xAxis && typeof rawOption.xAxis === "object" ? { ...rawOption.xAxis } : {};
  const rawAxisLabels = Array.isArray(rawXAxis.data) ? rawXAxis.data : [];
  const xLabels = rawAxisLabels.length
    ? sanitizeAxisLabels(rawAxisLabels, maxSeriesLength, 22)
    : Array.from({ length: maxSeriesLength }, (_, idx) => String(idx + 1));
  const hasTimeAxis = xLabels.filter((label) => TIME_AXIS_LABEL_RE.test(label)).length >= 2;
  const axisLabel = rawXAxis.axisLabel && typeof rawXAxis.axisLabel === "object" ? { ...rawXAxis.axisLabel } : undefined;
  if (hasTimeAxis) {
    rawXAxis.axisLabel = {
      ...(axisLabel || {}),
      hideOverlap: axisLabel?.hideOverlap ?? true,
    };
  }

  const series = parsedSeries.map((item) => ({
    ...item,
    stack: chartType === "stacked_bar" ? item.stack || "total" : undefined,
    areaStyle: chartType === "area" || chartType === "timeline" ? { opacity: 0.16 } : item.areaStyle,
  }));

  return {
    tooltip: { trigger: chartType === "scatter" ? "item" : "axis" },
    color: Array.isArray(rawOption?.color) ? rawOption.color.slice(0, 10) : undefined,
    legend: rawOption?.legend && typeof rawOption.legend === "object"
      ? { ...rawOption.legend }
      : series.length > 1
        ? { top: 8 }
        : undefined,
    grid: rawOption?.grid && typeof rawOption.grid === "object" ? { ...rawOption.grid } : undefined,
    xAxis: chartType === "scatter"
      ? { ...(rawOption?.xAxis || {}), type: "value", name: sanitizeText(rawOption?.xAxis?.name, 20, "") }
      : { ...rawXAxis, type: "category", data: xLabels },
    yAxis: { ...(rawOption?.yAxis || {}), type: rawOption?.yAxis?.type || "value", name: yAxisName },
    series,
  };
}

function sanitizeHeatmapOption(rawOption = {}) {
  const xData = sanitizeStringArray(rawOption?.xAxis?.data || [], 24, 18);
  const yData = sanitizeStringArray(rawOption?.yAxis?.data || [], 14, 18);
  const rawData = Array.isArray(rawOption?.series?.[0]?.data) ? rawOption.series[0].data : [];
  const data = rawData
    .map((item) => Array.isArray(item) ? [toNum(item[0], NaN), toNum(item[1], NaN), toNum(item[2], NaN)] : null)
    .filter(Boolean)
    .slice(0, 120);
  if (!xData.length || !yData.length || !data.length) return null;
  const values = data.map((entry) => entry[2]).filter(Number.isFinite);
  const derivedMin = values.length ? Math.min(...values) : 0;
  const derivedMax = values.length ? Math.max(...values) : 1;
  const rawVisualMap = rawOption?.visualMap && typeof rawOption.visualMap === "object" ? rawOption.visualMap : {};
  const min = Number.isFinite(Number(rawVisualMap.min)) ? Number(rawVisualMap.min) : derivedMin;
  const max = Number.isFinite(Number(rawVisualMap.max)) ? Number(rawVisualMap.max) : (derivedMax > derivedMin ? derivedMax : derivedMin + 1);
  return {
    tooltip: rawOption?.tooltip && typeof rawOption.tooltip === "object" ? { ...rawOption.tooltip } : { position: "top" },
    color: Array.isArray(rawOption?.color) ? rawOption.color.slice(0, 10) : undefined,
    grid: rawOption?.grid && typeof rawOption.grid === "object" ? { ...rawOption.grid } : undefined,
    xAxis: { ...(rawOption?.xAxis || {}), type: "category", data: xData },
    yAxis: { ...(rawOption?.yAxis || {}), type: "category", data: yData },
    visualMap: {
      ...rawVisualMap,
      min,
      max,
      calculable: Boolean(rawVisualMap.calculable),
      orient: rawVisualMap.orient || "horizontal",
      bottom: rawVisualMap.bottom ?? 0,
      inRange: rawVisualMap.inRange && typeof rawVisualMap.inRange === "object" ? { ...rawVisualMap.inRange } : undefined,
    },
    series: [{
      ...(rawOption?.series?.[0] || {}),
      type: "heatmap",
      data,
    }],
  };
}

function sanitizeRadarOption(rawOption = {}) {
  const indicators = (Array.isArray(rawOption?.radar?.indicator) ? rawOption.radar.indicator : [])
    .map((item, idx) => ({
      name: sanitizeText(item?.name, 24, `Metric ${idx + 1}`),
      max: Math.max(1, toNum(item?.max, 100)),
    }))
    .slice(0, 6);
  const values = Array.isArray(rawOption?.series?.[0]?.data?.[0]?.value)
    ? rawOption.series[0].data[0].value.map((value) => toNum(value, NaN)).filter(Number.isFinite).slice(0, indicators.length)
    : [];
  if (!indicators.length || !values.length) return null;
  return {
    radar: { indicator: indicators },
    series: [{ type: "radar", data: [{ value: values, name: sanitizeText(rawOption?.series?.[0]?.data?.[0]?.name, 24, "Summary") }] }],
  };
}

function sanitizeBoxplotOption(rawOption = {}) {
  const labels = sanitizeStringArray(rawOption?.xAxis?.data || [], 12, 18);
  const rawData = Array.isArray(rawOption?.series?.[0]?.data) ? rawOption.series[0].data : [];
  const data = rawData
    .map((row) => Array.isArray(row) ? row.map((value) => toNum(value, NaN)).filter(Number.isFinite).slice(0, 5) : null)
    .filter((row) => row && row.length === 5)
    .slice(0, labels.length || 12);
  if (!data.length) return null;
  return {
    xAxis: { type: "category", data: labels.length ? labels : data.map((_, idx) => String(idx + 1)) },
    yAxis: { type: "value" },
    series: [{ type: "boxplot", data }],
  };
}

function validateChartSpec(input, fallbackTitle = "Your Health Data") {
  if (!input || typeof input !== "object") return fallbackChartSpec(fallbackTitle);

  const chart_type = SUPPORTED_CHART_TYPES.has(String(input.chart_type || "").toLowerCase())
    ? String(input.chart_type).toLowerCase()
    : "bar";

  const title = sanitizeText(input.title, MAX_TITLE, sanitizeText(fallbackTitle, MAX_TITLE, "Your Health Data"));
  const subtitle = sanitizeText(input.subtitle, MAX_SUBTITLE, "");
  const takeaway = sanitizeText(input.takeaway, MAX_TAKEAWAY, "");
  const suggested_follow_up = sanitizeFollowUps(input.suggested_follow_up || input.suggestedFollowUp);
  const rawOption = input.option && typeof input.option === "object" ? input.option : {};

  let option = null;
  if (chart_type === "gauge") option = sanitizeGaugeOption(rawOption);
  else if (chart_type === "pie") option = sanitizePieOption(rawOption);
  else if (chart_type === "list_summary" || chart_type === "composed_summary") option = sanitizeListSummaryOption(rawOption, input);
  else if (chart_type === "heatmap") option = sanitizeHeatmapOption(rawOption);
  else if (chart_type === "radar") option = sanitizeRadarOption(rawOption);
  else if (chart_type === "boxplot") option = sanitizeBoxplotOption(rawOption);
  else option = sanitizeCartesianOption(rawOption, chart_type);

  if (!option) return fallbackChartSpec(title, takeaway || "I could not prepare that chart safely.");

  return {
    chart_type,
    title,
    subtitle,
    takeaway,
    highlight: input.highlight && typeof input.highlight === "object" ? input.highlight : null,
    suggested_follow_up,
    option: applyPremiumHealthTheme(option, { title, chartType: chart_type }),
  };
}

export { SUPPORTED_CHART_TYPES, fallbackChartSpec, validateChartSpec };
