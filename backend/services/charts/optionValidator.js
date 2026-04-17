/**
 * backend/services/charts/optionValidator.js
 *
 * Validates and sanitizes LLM-generated ECharts option objects before
 * they are persisted to MongoDB and delivered to the frontend.
 *
 * The frontend (chartSpec.js) does its own sanitization per chart type,
 * but this backend layer catches: data point overflow, dangerous keys,
 * and script injection before the option ever leaves the server.
 */

"use strict";

const MAX_TOTAL_DATA_POINTS = 90;
const MAX_AXIS_LABEL_LEN = 24;
const MAX_SERIES = 6;

// Whitelist of allowed top-level ECharts option keys.
// Any key not in this set is stripped silently.
const ALLOWED_TOP_LEVEL_KEYS = new Set([
  "xAxis",
  "yAxis",
  "series",
  "radar",
  "visualMap",
  "tooltip",
  "legend",
  "grid",
  "graphic",
  "color",
  "backgroundColor",
  "textStyle",
  "aria",
  "animationDuration",
  "animationEasing",
  "animation",
  "animationThreshold",
  "animationDurationUpdate",
  "animationEasingUpdate",
  "animationDelayUpdate",
]);

// Strings that are never allowed in string values
const INJECTION_PATTERNS = [
  /<script/i,
  /javascript:/i,
  /on\w+\s*=/i,  // onclick=, onload=, etc.
  /eval\s*\(/i,
  /new\s+Function/i,
];

function isSafeString(value) {
  if (typeof value !== "string") return true;
  return !INJECTION_PATTERNS.some((pattern) => pattern.test(value));
}

function sanitizeString(value, maxLen = MAX_AXIS_LABEL_LEN) {
  if (typeof value !== "string") return value;
  if (!isSafeString(value)) return "";
  return value.slice(0, maxLen);
}

/**
 * Recursively walk an object/array and:
 *  - Remove any function values
 *  - Strip any string containing injection patterns
 *  - Truncate long strings
 */
function deepSanitize(value, depth = 0) {
  if (depth > 8) return null; // guard against pathological nesting
  if (typeof value === "function") return null;
  if (typeof value === "string") return isSafeString(value) ? value : "";
  if (Array.isArray(value)) {
    return value.map((item) => deepSanitize(item, depth + 1)).filter((item) => item !== null);
  }
  if (value !== null && typeof value === "object") {
    const result = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "function") continue;
      const sanitized = deepSanitize(v, depth + 1);
      if (sanitized !== null) result[k] = sanitized;
    }
    return result;
  }
  return value; // number, boolean, null
}

/**
 * Count total data points across all series in the option.
 */
function countDataPoints(option) {
  const series = Array.isArray(option.series) ? option.series : [];
  let total = 0;
  for (const s of series) {
    const data = Array.isArray(s?.data) ? s.data : [];
    total += data.length;
  }
  return total;
}

/**
 * Truncate series data arrays so total data points stay within MAX_TOTAL_DATA_POINTS.
 * Also caps number of series to MAX_SERIES.
 */
function truncateDataPoints(option) {
  if (!Array.isArray(option.series)) return option;
  const series = option.series.slice(0, MAX_SERIES);
  const total = series.reduce((sum, s) => sum + (Array.isArray(s?.data) ? s.data.length : 0), 0);
  if (total <= MAX_TOTAL_DATA_POINTS) {
    return { ...option, series };
  }
  // Proportionally truncate each series
  const maxPerSeries = Math.floor(MAX_TOTAL_DATA_POINTS / series.length);
  return {
    ...option,
    series: series.map((s) => ({
      ...s,
      data: Array.isArray(s?.data) ? s.data.slice(0, maxPerSeries) : s?.data,
    })),
  };
}

/**
 * Strip top-level keys that are not in the whitelist.
 */
function stripUnknownTopLevelKeys(option) {
  const result = {};
  for (const key of Object.keys(option)) {
    if (ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      result[key] = option[key];
    }
  }
  return result;
}

/**
 * Sanitize axis label strings in xAxis and yAxis.data arrays.
 * Handles both single axis (object) and dual axis (array) forms.
 */
function sanitizeAxisLabels(axis) {
  if (!axis) return axis;
  if (Array.isArray(axis)) {
    return axis.map((ax) => sanitizeAxisLabels(ax));
  }
  if (typeof axis !== "object") return axis;
  const result = { ...axis };
  if (Array.isArray(result.data)) {
    result.data = result.data.map((label) =>
      typeof label === "string" ? sanitizeString(label) : label
    );
  }
  return result;
}

/**
 * Validate and sanitize an LLM-generated ECharts option object.
 *
 * @param {*}      rawOption  - The option object from the LLM
 * @param {string} chartType  - The declared chart_type
 * @returns {{ ok: boolean, sanitizedOption: object|null, errors: string[] }}
 */
function validateLLMGeneratedOption(rawOption, chartType = "") {
  const errors = [];

  if (!rawOption || typeof rawOption !== "object" || Array.isArray(rawOption)) {
    return { ok: false, sanitizedOption: null, errors: ["option must be a non-null object"] };
  }

  // 1. Strip unknown top-level keys
  let option = stripUnknownTopLevelKeys(rawOption);

  if (!Object.keys(option).length) {
    errors.push("option has no recognized ECharts keys after whitelist filtering");
    return { ok: false, sanitizedOption: null, errors };
  }

  // 2. Deep sanitize — removes functions and injection strings
  option = deepSanitize(option);
  if (!option || typeof option !== "object") {
    return { ok: false, sanitizedOption: null, errors: ["option became null after sanitization"] };
  }

  // 3. Sanitize axis labels
  if (option.xAxis !== undefined) option.xAxis = sanitizeAxisLabels(option.xAxis);
  if (option.yAxis !== undefined) option.yAxis = sanitizeAxisLabels(option.yAxis);

  // 4. Truncate data points
  option = truncateDataPoints(option);

  // 5. Must have series for non-radar/non-graphic chart types
  const needsSeries = !["radar"].includes(String(chartType).toLowerCase());
  if (needsSeries && (!Array.isArray(option.series) || !option.series.length)) {
    errors.push(`chart_type '${chartType}' requires a series array`);
    return { ok: false, sanitizedOption: null, errors };
  }

  return { ok: true, sanitizedOption: option, errors };
}

module.exports = { validateLLMGeneratedOption };
