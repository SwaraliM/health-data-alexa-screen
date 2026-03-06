/**
 * frontend/src/utils/chartSpec.js
 *
 * Frontend-side chart_spec guardrail.
 *
 * Even after backend validation, this layer keeps rendering deterministic by:
 * - allowing only supported chart types,
 * - clamping point counts,
 * - enforcing axis/data alignment,
 * - falling back to a safe readable option.
 */

import { applyPremiumHealthTheme } from "./echartsTheme";

const SUPPORTED_CHART_TYPES = new Set([
  "bar",
  "grouped_bar",
  "line",
  "gauge",
  "pie",
  "single_value",
  "list_summary",
]);

const MAX_POINTS = 60;
const MAX_TITLE = 80;
const MAX_SUBTITLE = 120;
const MAX_TAKEAWAY = 220;
const MAX_FOLLOW_UP = 4;
const MAX_SERIES = 3;
const MAX_LIST_ITEMS = 8;

const toNum = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const sanitizeText = (value, max = 80, fallback = "") => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return fallback;
  return text.slice(0, max);
};

const sanitizeStringArray = (values, maxItems = MAX_POINTS, maxLen = 24) => {
  if (!Array.isArray(values)) return [];
  return values
    .map((v) => sanitizeText(v, maxLen, ""))
    .filter(Boolean)
    .slice(0, maxItems);
};

const sanitizeNumberArray = (values, maxItems = MAX_POINTS) => {
  if (!Array.isArray(values)) return [];
  return values
    .map((v) => toNum(v, NaN))
    .filter((v) => Number.isFinite(v))
    .slice(0, maxItems);
};

const sanitizeFollowUps = (values) => {
  if (!Array.isArray(values)) return [];
  return values
    .map((v) => sanitizeText(v, 80, ""))
    .filter(Boolean)
    .slice(0, MAX_FOLLOW_UP);
};

function fallbackChartSpec(title = "Your Health Data", takeaway = "I could not prepare that chart safely.") {
  const safeTitle = sanitizeText(title, MAX_TITLE, "Your Health Data");
  const option = {
    tooltip: { trigger: "axis" },
    xAxis: { type: "category", data: ["M", "T", "W", "Th", "F", "Sa", "Su"] },
    yAxis: { type: "value" },
    series: [{ type: "bar", name: "No data", data: [0, 0, 0, 0, 0, 0, 0] }],
  };

  return {
    chart_type: "bar",
    title: safeTitle,
    subtitle: "Last 7 days",
    takeaway: sanitizeText(takeaway, MAX_TAKEAWAY, "I could not prepare that chart safely."),
    highlight: null,
    suggested_follow_up: ["Can you show my last 7 days of steps?"],
    option: applyPremiumHealthTheme(option, { title: safeTitle, chartType: "bar" }),
  };
}

function sanitizeCartesianOption(rawOption = {}, chartType = "bar") {
  const xAxisInput = Array.isArray(rawOption.xAxis) ? rawOption.xAxis[0] : rawOption.xAxis || {};
  const yAxisInput = Array.isArray(rawOption.yAxis) ? rawOption.yAxis[0] : rawOption.yAxis || {};
  const labels = sanitizeStringArray(xAxisInput.data || xAxisInput.labels || [], MAX_POINTS, 22);
  const optionColors = Array.isArray(rawOption.color)
    ? rawOption.color.filter((value) => typeof value === "string" && value.trim()).slice(0, MAX_SERIES)
    : [];

  const desiredSeriesType = chartType === "line" ? "line" : "bar";
  const rawSeries = Array.isArray(rawOption.series) ? rawOption.series.slice(0, MAX_SERIES) : [];

  const parsedSeries = rawSeries
    .map((seriesItem, idx) => {
      const data = sanitizeNumberArray(seriesItem?.data || [], MAX_POINTS);
      if (!data.length) return null;
      return {
        type: desiredSeriesType,
        name: sanitizeText(seriesItem?.name, 24, `Series ${idx + 1}`),
        data,
        itemStyle: seriesItem?.itemStyle && typeof seriesItem.itemStyle === "object"
          ? { ...seriesItem.itemStyle }
          : undefined,
        label: seriesItem?.label && typeof seriesItem.label === "object"
          ? { ...seriesItem.label }
          : undefined,
        markLine: seriesItem?.markLine && typeof seriesItem.markLine === "object"
          ? { ...seriesItem.markLine }
          : undefined,
      };
    })
    .filter(Boolean);

  if (!parsedSeries.length) return null;

  let safeLabels = labels;
  if (!safeLabels.length) {
    const longest = Math.min(
      MAX_POINTS,
      Math.max(...parsedSeries.map((item) => item.data.length))
    );
    safeLabels = Array.from({ length: longest }, (_, idx) => String(idx + 1));
  }

  const minLen = Math.min(safeLabels.length, ...parsedSeries.map((item) => item.data.length));
  if (!Number.isFinite(minLen) || minLen <= 0) return null;

  const labelsCut = safeLabels.slice(0, minLen);
  const seriesCut = parsedSeries.map((item) => ({
    ...item,
    data: item.data.slice(0, minLen),
  }));

  const limitedSeries = chartType === "grouped_bar"
    ? seriesCut.slice(0, MAX_SERIES)
    : seriesCut.slice(0, 1);

  return {
    color: optionColors.length ? optionColors : undefined,
    tooltip: { trigger: "axis" },
    legend: limitedSeries.length > 1 ? { top: 8 } : undefined,
    xAxis: { type: "category", data: labelsCut },
    yAxis: { type: "value", name: sanitizeText(yAxisInput?.name, 20, "") },
    series: limitedSeries,
  };
}

function sanitizePieOption(rawOption = {}) {
  const rawSeries = Array.isArray(rawOption.series) ? rawOption.series[0] : null;
  const rawData = Array.isArray(rawSeries?.data) ? rawSeries.data : [];

  const data = rawData
    .map((item, idx) => ({
      name: sanitizeText(item?.name, 24, `Item ${idx + 1}`),
      value: toNum(item?.value, NaN),
    }))
    .filter((item) => Number.isFinite(item.value))
    .slice(0, MAX_LIST_ITEMS);

  if (!data.length) return null;

  return {
    tooltip: { trigger: "item" },
    legend: { bottom: 0 },
    series: [
      {
        type: "pie",
        radius: ["40%", "72%"],
        data,
      },
    ],
  };
}

function sanitizeGaugeOption(rawOption = {}) {
  const rawSeries = Array.isArray(rawOption.series) ? rawOption.series[0] : {};
  const rawDataPoint = Array.isArray(rawSeries?.data) ? rawSeries.data[0] : {};
  const max = Math.max(1, toNum(rawSeries?.max ?? rawOption?.max, 100));
  const value = Math.max(0, Math.min(max, toNum(rawDataPoint?.value ?? rawOption?.value, 0)));
  const name = sanitizeText(rawDataPoint?.name || rawOption?.name, 24, "Progress");

  return {
    series: [
      {
        type: "gauge",
        max,
        progress: { show: true, width: 16 },
        axisLine: { lineStyle: { width: 16 } },
        pointer: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
        detail: { formatter: "{value}", fontSize: 26, fontWeight: 700 },
        data: [{ value, name }],
      },
    ],
  };
}

function sanitizeSingleValueOption(rawOption = {}, spec = {}) {
  const value = toNum(spec?.highlight?.value ?? rawOption?.value, 0);
  const unit = sanitizeText(rawOption?.unit, 12, "");
  const label = sanitizeText(spec?.takeaway, 90, "Latest value");

  return {
    value,
    unit,
    graphic: [
      {
        type: "text",
        left: "center",
        top: "35%",
        style: {
          text: unit ? `${Math.round(value)} ${unit}` : `${Math.round(value)}`,
          fontSize: 44,
          fontWeight: 700,
          fill: "#0F172A",
        },
      },
      {
        type: "text",
        left: "center",
        top: "58%",
        style: {
          text: label,
          fontSize: 16,
          fill: "#334155",
        },
      },
    ],
  };
}

function sanitizeListSummaryOption(rawOption = {}, spec = {}) {
  const entries = Array.isArray(rawOption.items)
    ? rawOption.items
    : Array.isArray(spec?.list)
      ? spec.list
      : [];

  const lines = entries
    .map((entry) => sanitizeText(entry, 96, ""))
    .filter(Boolean)
    .slice(0, MAX_LIST_ITEMS);

  const text = lines.length ? lines.map((line) => `• ${line}`).join("\n") : "• No details available";

  return {
    items: lines,
    graphic: [
      {
        type: "text",
        left: "5%",
        top: "10%",
        style: {
          text,
          fontSize: 16,
          lineHeight: 28,
          fill: "#1E293B",
        },
      },
    ],
  };
}

function validateChartSpec(input, fallbackTitle = "Your Health Data") {
  if (!input || typeof input !== "object") return fallbackChartSpec(fallbackTitle);

  const rawType = sanitizeText(input.chart_type || input.chartType, 20, "bar").toLowerCase();
  const chartType = SUPPORTED_CHART_TYPES.has(rawType) ? rawType : "bar";

  const title = sanitizeText(input.title, MAX_TITLE, sanitizeText(fallbackTitle, MAX_TITLE, "Your Health Data"));
  const subtitle = sanitizeText(input.subtitle, MAX_SUBTITLE, "");
  const takeaway = sanitizeText(input.takeaway, MAX_TAKEAWAY, "");
  const suggestedFollowUp = sanitizeFollowUps(input.suggested_follow_up || input.suggestedFollowUp);

  const highlight = input?.highlight && typeof input.highlight === "object"
    ? {
        label: sanitizeText(input.highlight.label, 40, ""),
        reason: sanitizeText(input.highlight.reason, 40, ""),
        value: Number.isFinite(toNum(input.highlight.value, NaN)) ? toNum(input.highlight.value, NaN) : undefined,
      }
    : null;

  const rawOption = input.option && typeof input.option === "object" ? input.option : {};

  let option = null;
  if (chartType === "pie") option = sanitizePieOption(rawOption);
  else if (chartType === "gauge") option = sanitizeGaugeOption(rawOption);
  else if (chartType === "single_value") option = sanitizeSingleValueOption(rawOption, input);
  else if (chartType === "list_summary") option = sanitizeListSummaryOption(rawOption, input);
  else option = sanitizeCartesianOption(rawOption, chartType);

  if (!option) return fallbackChartSpec(title, takeaway || "I could not prepare that chart safely.");

  return {
    chart_type: chartType,
    title,
    subtitle,
    takeaway,
    highlight: highlight && (highlight.label || highlight.reason || Number.isFinite(highlight.value))
      ? highlight
      : null,
    suggested_follow_up: suggestedFollowUp,
    option: applyPremiumHealthTheme(option, { title, chartType }),
  };
}

export { SUPPORTED_CHART_TYPES, fallbackChartSpec, validateChartSpec };
