// backend/services/charts/chartPresetHydrator.js

const { validateChartSpec, buildFallbackChartSpec } = require("../chartSpecService");
const presets = require("./chartPresetLibrary");

const PRESET_BUILDERS = {
  bar: presets.buildBarOption,
  grouped_bar: presets.buildGroupedBarOption,
  line: presets.buildLineOption,
  multi_line: presets.buildMultiLineOption,
  stacked_bar: presets.buildStackedBarOption,
  area: presets.buildAreaOption,
  scatter: presets.buildScatterOption,
  heatmap: presets.buildHeatmapOption,
  radar: presets.buildRadarOption,
  gauge: presets.buildGaugeOption,
  pie: presets.buildPieOption,
  timeline: presets.buildTimelineOption,
  list_summary: presets.buildListSummaryOption,
  composed_summary: presets.buildComposedSummaryOption,
};

function sanitizeText(value, max = 120, fallback = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : fallback;
}

/**
 * Takes the GPT executor output (with chart_type + chart_data instead of option)
 * and returns a fully validated chartSpec ready for the frontend.
 *
 * @param {object} gptChartSpec - the chart_spec field from executor GPT output.
 * @param {string} fallbackTitle
 * @returns validated chartSpec with hydrated ECharts option object
 */
function hydrateChartSpec(gptChartSpec, fallbackTitle = "Health Summary") {
  if (!gptChartSpec || typeof gptChartSpec !== "object") {
    return buildFallbackChartSpec(fallbackTitle, "The chart data was missing.");
  }

  const chartType = String(gptChartSpec.chart_type || "").toLowerCase();
  const chartData = gptChartSpec.chart_data;

  try {
    const builder = PRESET_BUILDERS[chartType];
    if (!builder) {
      throw new Error("Unsupported chart_type: " + chartType);
    }
    if (!chartData || typeof chartData !== "object") {
      throw new Error("chart_data missing or invalid");
    }

    const title = sanitizeText(gptChartSpec.title, 120, fallbackTitle);
    const subtitle = sanitizeText(gptChartSpec.subtitle, 160, "");
    const takeaway = sanitizeText(gptChartSpec.takeaway, 220, "");
    const meta = {
      title,
      subtitle,
      takeaway,
      timeScope: sanitizeText(gptChartSpec.time_scope || gptChartSpec.timeScope, 40, ""),
      unit: sanitizeText(chartData.unit || gptChartSpec.unit, 20, ""),
    };

    const option = builder(chartData, meta);
    const hydratedSpec = {
      ...gptChartSpec,
      chart_type: chartType,
      title,
      subtitle,
      takeaway,
      option,
    };

    return validateChartSpec(hydratedSpec, title || fallbackTitle);
  } catch (error) {
    let preview = "";
    try {
      preview = JSON.stringify(chartData || {}).slice(0, 300);
    } catch (_) {
      preview = String(chartData || "").slice(0, 300);
    }

    console.warn("[ChartPresetHydrator] hydrateChartSpec: builder failed", {
      chart_type: chartType,
      error: String(error?.message || error),
      chart_data_preview: preview,
    });

    const safeTitle = sanitizeText(fallbackTitle, 80, "Health Summary");
    const safeTakeaway = sanitizeText(gptChartSpec.takeaway, 180, "I could not prepare that chart.");
    return buildFallbackChartSpec(safeTitle, safeTakeaway);
  }
}

module.exports = { hydrateChartSpec };
