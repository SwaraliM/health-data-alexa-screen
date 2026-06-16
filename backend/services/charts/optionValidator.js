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

// ─── Cartesian normalization (axis/series readability guardrails) ─────────────

// Cartesian category charts we normalize. Others (scatter pairs, radar, pie,
// donut, gauge, heatmap, list/composed summary) are left untouched.
const NORMALIZABLE_CHART_TYPES = new Set([
  "bar", "line", "area", "stacked_bar", "grouped_bar", "multi_line", "dual_axis",
]);

// Ordered unit inference from a series name. First match wins.
const UNIT_RULES = [
  { unit: "%", label: "Percent (%)", re: /%|percent|efficiency|spo|oxygen|saturation/i },
  { unit: "hrs", label: "Hours (hrs)", re: /\b(hours?|hrs?)\b|\(h(rs)?\)/i },
  { unit: "min", label: "Minutes (min)", re: /\bmin(ute)?s?\b|\bminutes\b|zone minutes|asleep|awake|deep|rem|light/i },
  { unit: "bpm", label: "Heart Rate (bpm)", re: /\bbpm\b|heart rate|resting hr|pulse/i },
  { unit: "ms", label: "HRV (ms)", re: /\bhrv\b|\bms\b|variability|rmssd/i },
  { unit: "br", label: "Breaths/min", re: /breath|respiration/i },
  { unit: "steps", label: "Steps", re: /\bsteps?\b/i },
  { unit: "cal", label: "Calories", re: /\bcal(orie)?s?\b|energy|burn/i },
  { unit: "mi", label: "Distance (mi)", re: /\b(miles?|mi|km|distance)\b/i },
  { unit: "floors", label: "Floors", re: /\bfloors?\b|stairs|flights/i },
];

function inferUnit(seriesName) {
  const name = String(seriesName || "");
  for (const rule of UNIT_RULES) {
    if (rule.re.test(name)) return rule;
  }
  return { unit: "value", label: "Value", re: null };
}

function hasCategoryXAxis(option) {
  const x = Array.isArray(option.xAxis) ? option.xAxis[0] : option.xAxis;
  return Array.isArray(x?.data) && x.data.length > 0;
}

/**
 * Make every flat numeric series the same length as the category x-axis
 * (pad with null, truncate if longer). Leaves [x,y]-pair series alone.
 */
function alignSeriesToAxis(option) {
  const x = Array.isArray(option.xAxis) ? option.xAxis[0] : option.xAxis;
  const len = Array.isArray(x?.data) ? x.data.length : null;
  if (!len || !Array.isArray(option.series)) return option;
  const series = option.series.map((s) => {
    if (!s || !Array.isArray(s.data)) return s;
    if (s.data.some((d) => Array.isArray(d))) return s; // [x,y] pairs — skip
    let data = s.data.slice(0, len);
    while (data.length < len) data.push(null);
    return { ...s, data };
  });
  return { ...option, series };
}

/**
 * Enforce readable units-per-axis:
 *  - group series by inferred unit; rank groups by (#series desc, first appearance)
 *  - 1 group  → single y-axis
 *  - 2 groups → dual y-axis (group2 → yAxisIndex 1)
 *  - 3+ groups → keep the top 2 groups (dual axis), drop the rest
 * Stacked bars (single unit) are unaffected.
 */
function enforceUnitAxes(option) {
  if (!Array.isArray(option.series) || option.series.length <= 1) return option;
  // scatter pair series are excluded upstream; here all series are flat.
  const groupsOrder = [];
  const groups = new Map(); // unit -> { label, indices: [] }
  option.series.forEach((s, i) => {
    const { unit, label } = inferUnit(s?.name);
    if (!groups.has(unit)) {
      groups.set(unit, { label, indices: [] });
      groupsOrder.push(unit);
    }
    groups.get(unit).indices.push(i);
  });

  if (groups.size <= 1) return option; // single unit — nothing to do

  // Rank: more series first, then earlier appearance.
  const ranked = [...groups.entries()].sort((a, b) => {
    const d = b[1].indices.length - a[1].indices.length;
    if (d !== 0) return d;
    return groupsOrder.indexOf(a[0]) - groupsOrder.indexOf(b[0]);
  });
  const keep = ranked.slice(0, 2);
  const keepUnits = new Set(keep.map(([u]) => u));
  const axisIndexForUnit = new Map(keep.map(([u], idx) => [u, idx]));

  // Keep only series in the top-2 unit groups; assign yAxisIndex by group.
  const newSeries = [];
  const namesByAxis = [[], []];
  option.series.forEach((s) => {
    const { unit } = inferUnit(s?.name);
    if (!keepUnits.has(unit)) return; // drop 3rd+ unit group
    const axisIdx = axisIndexForUnit.get(unit);
    newSeries.push({ ...s, yAxisIndex: axisIdx });
    namesByAxis[axisIdx].push(s?.name);
  });

  // Label each axis from its OWN series (never from the author's positional
  // names, which can be mismatched): a single-series axis takes the series
  // name (e.g. "Resting HR (bpm)"); a multi-series axis takes the unit label
  // (e.g. "Minutes (min)").
  const buildAxis = (groupEntry, idx) => {
    const names = namesByAxis[idx] || [];
    const name = names.length === 1 ? names[0] : groupEntry[1].label;
    return { type: "value", name };
  };

  const result = { ...option, series: newSeries };
  if (keep.length === 2) {
    result.yAxis = [buildAxis(keep[0], 0), buildAxis(keep[1], 1)];
  } else {
    result.yAxis = buildAxis(keep[0], 0);
  }
  return result;
}

/**
 * Apply cartesian readability normalization for category charts only.
 */
function normalizeCartesianOption(option, chartType) {
  if (!NORMALIZABLE_CHART_TYPES.has(String(chartType).toLowerCase())) return option;
  if (!hasCategoryXAxis(option)) return option;
  // Skip if any series uses [x,y] pairs (defensive — shouldn't happen for these types).
  const series = Array.isArray(option.series) ? option.series : [];
  if (series.some((s) => Array.isArray(s?.data) && s.data.some((d) => Array.isArray(d)))) return option;
  let out = alignSeriesToAxis(option);
  out = enforceUnitAxes(out);
  return out;
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

  // 4b. Cartesian readability: align series to x-axis length; cap to <=2 unit
  // groups via dual y-axis (drop 3rd+ unit group). Keeps charts legible.
  option = normalizeCartesianOption(option, chartType);

  // 5. Must have series for chart types that require it.
  // Graphic-first types (radar, list_summary, composed_summary) render via ECharts
  // `graphic` elements rather than series — they must not be rejected here.
  const noSeriesNeeded = ["radar", "list_summary", "composed_summary"];
  const needsSeries = !noSeriesNeeded.includes(String(chartType).toLowerCase());
  if (needsSeries && (!Array.isArray(option.series) || !option.series.length)) {
    errors.push(`chart_type '${chartType}' requires a series array`);
    return { ok: false, sanitizedOption: null, errors };
  }

  return { ok: true, sanitizedOption: option, errors };
}

module.exports = { validateLLMGeneratedOption };
