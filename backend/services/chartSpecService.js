/**
 * backend/services/chartSpecService.js
 *
 * Central validator/sanitizer for the single chart_spec format.
 *
 * Why this exists:
 * - Planner output can be incomplete or malformed.
 * - Backend analytics can still produce edge-case arrays.
 * - Frontend should receive one safe, predictable ECharts option object.
 */

const SUPPORTED_CHART_TYPES = new Set([
  "bar",
  "grouped_bar",
  "line",
  "gauge",
  "pie",
  "single_value",
  "list_summary",
]);

const MAX_TITLE = 80;
const MAX_SUBTITLE = 120;
const MAX_TAKEAWAY = 220;
const MAX_FOLLOW_UP = 4;
const MAX_POINTS = 60;
const MAX_SERIES = 3;
const MAX_LIST_ITEMS = 8;

function toFiniteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function sanitizeText(value, max = 80, fallback = "") {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return fallback;
  return text.slice(0, max);
}

function sanitizeStringArray(values, { maxItems = MAX_POINTS, maxLen = 24 } = {}) {
  if (!Array.isArray(values)) return [];
  return values
    .map((v) => sanitizeText(v, maxLen, ""))
    .filter(Boolean)
    .slice(0, maxItems);
}

function sanitizeNumericArray(values, maxItems = MAX_POINTS) {
  if (!Array.isArray(values)) return [];
  return values
    .map((v) => toFiniteNumber(v, NaN))
    .filter((v) => Number.isFinite(v))
    .slice(0, maxItems);
}

function sanitizeFollowUps(values) {
  if (!Array.isArray(values)) return [];
  return values
    .map((v) => sanitizeText(v, 80, ""))
    .filter(Boolean)
    .slice(0, MAX_FOLLOW_UP);
}

function sanitizeHighlight(value) {
  if (!value || typeof value !== "object") return null;
  const label = sanitizeText(value.label, 40, "");
  const reason = sanitizeText(value.reason, 40, "");
  const numericValue = toFiniteNumber(value.value, NaN);

  if (!label && !Number.isFinite(numericValue) && !reason) return null;
  return {
    label: label || undefined,
    value: Number.isFinite(numericValue) ? numericValue : undefined,
    reason: reason || undefined,
  };
}

function buildFallbackChartSpec(title = "Your Health Data", takeaway = "I could not prepare that chart safely.") {
  return {
    chart_type: "bar",
    title: sanitizeText(title, MAX_TITLE, "Your Health Data"),
    subtitle: "Last 7 days",
    takeaway: sanitizeText(takeaway, MAX_TAKEAWAY, "I could not prepare that chart safely."),
    highlight: null,
    suggested_follow_up: ["Can you show my last 7 days of steps?"],
    option: {
      tooltip: { trigger: "axis" },
      xAxis: {
        type: "category",
        data: ["M", "T", "W", "Th", "F", "Sa", "Su"],
      },
      yAxis: { type: "value" },
      series: [
        {
          type: "bar",
          name: "No data",
          data: [0, 0, 0, 0, 0, 0, 0],
        },
      ],
    },
  };
}

function sanitizeCartesianOption(option = {}, chartType = "bar") {
  const xAxisInput = Array.isArray(option.xAxis) ? option.xAxis[0] : option.xAxis || {};
  const yAxisInput = Array.isArray(option.yAxis) ? option.yAxis[0] : option.yAxis || {};
  const labels = sanitizeStringArray(xAxisInput.data || xAxisInput.labels || [], { maxItems: MAX_POINTS, maxLen: 22 });

  const rawSeries = Array.isArray(option.series) ? option.series.slice(0, MAX_SERIES) : [];
  const desiredSeriesType = chartType === "line" ? "line" : "bar";

  const series = rawSeries
    .map((seriesItem, index) => {
      const data = sanitizeNumericArray(seriesItem?.data || [], MAX_POINTS);
      if (!data.length) return null;
      return {
        type: desiredSeriesType,
        name: sanitizeText(seriesItem?.name, 24, `Series ${index + 1}`),
        data,
      };
    })
    .filter(Boolean);

  if (!series.length) return null;

  let safeLabels = labels;
  if (!safeLabels.length) {
    const longest = Math.min(
      MAX_POINTS,
      Math.max(...series.map((item) => item.data.length))
    );
    safeLabels = Array.from({ length: longest }, (_, idx) => String(idx + 1));
  }

  const minLen = Math.min(
    safeLabels.length,
    ...series.map((item) => item.data.length)
  );

  if (!Number.isFinite(minLen) || minLen <= 0) return null;

  const truncatedLabels = safeLabels.slice(0, minLen);
  const truncatedSeries = series.map((item) => ({
    ...item,
    data: item.data.slice(0, minLen),
  }));

  const limitedSeries = chartType === "grouped_bar"
    ? truncatedSeries.slice(0, 3)
    : truncatedSeries.slice(0, 1);

  return {
    tooltip: { trigger: "axis" },
    legend: limitedSeries.length > 1 ? { top: 8 } : undefined,
    xAxis: {
      type: "category",
      data: truncatedLabels,
    },
    yAxis: {
      type: "value",
      name: sanitizeText(yAxisInput?.name || "", 20, ""),
    },
    series: limitedSeries,
  };
}

function sanitizePieOption(option = {}) {
  const rawSeries = Array.isArray(option.series) ? option.series[0] : null;
  const rawData = Array.isArray(rawSeries?.data) ? rawSeries.data : [];

  const data = rawData
    .map((item, idx) => ({
      name: sanitizeText(item?.name, 24, `Item ${idx + 1}`),
      value: toFiniteNumber(item?.value, NaN),
    }))
    .filter((item) => Number.isFinite(item.value))
    .slice(0, MAX_LIST_ITEMS);

  if (!data.length) return null;

  return {
    tooltip: { trigger: "item" },
    legend: { orient: "horizontal", bottom: 0 },
    series: [
      {
        type: "pie",
        radius: ["40%", "70%"],
        data,
      },
    ],
  };
}

function sanitizeGaugeOption(option = {}) {
  const rawSeries = Array.isArray(option.series) ? option.series[0] : {};
  const max = Math.max(1, toFiniteNumber(rawSeries?.max ?? option?.max, 100));
  const rawData = Array.isArray(rawSeries?.data) ? rawSeries.data[0] : null;
  const value = Math.max(0, Math.min(max, toFiniteNumber(rawData?.value ?? option?.value, 0)));
  const name = sanitizeText(rawData?.name ?? option?.name, 28, "Progress");

  return {
    series: [
      {
        type: "gauge",
        max,
        progress: { show: true, width: 16 },
        axisLine: { lineStyle: { width: 16 } },
        pointer: { show: false },
        detail: { formatter: "{value}", fontSize: 26, fontWeight: 700 },
        data: [{ value, name }],
      },
    ],
  };
}

function sanitizeSingleValueOption(option = {}, spec = {}) {
  const value = toFiniteNumber(spec?.highlight?.value ?? option?.value, 0);
  const unit = sanitizeText(option?.unit || "", 12, "");

  return {
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
          text: sanitizeText(spec?.takeaway || "", 72, "Latest value"),
          fontSize: 16,
          fill: "#334155",
        },
      },
    ],
  };
}

function sanitizeListSummaryOption(option = {}, spec = {}) {
  const entries = Array.isArray(option?.items)
    ? option.items
    : Array.isArray(spec?.list)
      ? spec.list
      : [];

  const lines = entries
    .map((entry) => sanitizeText(entry, 90, ""))
    .filter(Boolean)
    .slice(0, MAX_LIST_ITEMS);

  const text = lines.length ? lines.map((line) => `• ${line}`).join("\n") : "• No details available";

  return {
    graphic: [
      {
        type: "text",
        left: "5%",
        top: "12%",
        style: {
          text,
          fontSize: 16,
          lineHeight: 28,
          fontWeight: 500,
          fill: "#1E293B",
        },
      },
    ],
  };
}

/**
 * Validates and normalizes one chart spec for the active ECharts renderer.
 * Returns a guaranteed-safe spec with fallback when needed.
 */
function validateChartSpec(input, fallbackTitle = "Your Health Data") {
  if (!input || typeof input !== "object") {
    return buildFallbackChartSpec(fallbackTitle);
  }

  const rawType = sanitizeText(input.chart_type || input.chartType, 20, "bar").toLowerCase();
  const chartType = SUPPORTED_CHART_TYPES.has(rawType) ? rawType : "bar";

  const title = sanitizeText(input.title, MAX_TITLE, sanitizeText(fallbackTitle, MAX_TITLE, "Your Health Data"));
  const subtitle = sanitizeText(input.subtitle, MAX_SUBTITLE, "");
  const takeaway = sanitizeText(input.takeaway, MAX_TAKEAWAY, "");
  const suggestedFollowUp = sanitizeFollowUps(input.suggested_follow_up || input.suggestedFollowUp);
  const highlight = sanitizeHighlight(input.highlight);

  const rawOption = input.option && typeof input.option === "object" ? input.option : {};

  let safeOption = null;
  if (chartType === "pie") safeOption = sanitizePieOption(rawOption);
  else if (chartType === "gauge") safeOption = sanitizeGaugeOption(rawOption);
  else if (chartType === "single_value") safeOption = sanitizeSingleValueOption(rawOption, input);
  else if (chartType === "list_summary") safeOption = sanitizeListSummaryOption(rawOption, input);
  else safeOption = sanitizeCartesianOption(rawOption, chartType);

  if (!safeOption) {
    return buildFallbackChartSpec(title, takeaway || "I could not prepare that chart safely.");
  }

  return {
    chart_type: chartType,
    title,
    subtitle,
    takeaway,
    highlight,
    suggested_follow_up: suggestedFollowUp,
    option: safeOption,
  };
}

module.exports = {
  SUPPORTED_CHART_TYPES,
  validateChartSpec,
  buildFallbackChartSpec,
};
