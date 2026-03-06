/**
 * backend/services/chartSpecService.js
 *
 * Final validation/sanitization step before the frontend sees a chart.
 */

const ALLOWED_TYPES = new Set([
  "bar",
  "grouped_bar",
  "line",
  "gauge",
  "list_summary",
  "pie",
]);

function sanitizeText(value, fallback = "", max = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return fallback;
  return text.slice(0, max);
}

function buildFallbackChartSpec(title = "Health Summary", takeaway = "I could not prepare that chart.") {
  return {
    chart_type: "list_summary",
    title: sanitizeText(title, "Health Summary", 80),
    subtitle: "Quick summary",
    takeaway: sanitizeText(takeaway, "I could not prepare that chart.", 180),
    option: {
      items: [takeaway],
      graphic: [
        {
          type: "text",
          left: "5%",
          top: "18%",
          style: {
            text: `• ${takeaway}`,
            fontSize: 18,
            lineHeight: 28,
            fill: "#1E293B",
          },
        },
      ],
    },
    suggested_follow_up: ["Try asking a simpler question."],
  };
}

function validateChartSpec(chartSpec = {}, fallbackTitle = "Health Summary") {
  if (!chartSpec || typeof chartSpec !== "object") {
    return buildFallbackChartSpec(fallbackTitle, "The chart data was missing.");
  }

  const chartType = ALLOWED_TYPES.has(String(chartSpec.chart_type || "").toLowerCase())
    ? String(chartSpec.chart_type).toLowerCase()
    : "list_summary";

  const title = sanitizeText(chartSpec.title, fallbackTitle, 80);
  const subtitle = sanitizeText(chartSpec.subtitle, "", 120);
  const takeaway = sanitizeText(chartSpec.takeaway, "Here is your summary.", 220);

  const option = chartSpec.option && typeof chartSpec.option === "object"
    ? chartSpec.option
    : buildFallbackChartSpec(title, takeaway).option;

  const suggested_follow_up = Array.isArray(chartSpec.suggested_follow_up)
    ? chartSpec.suggested_follow_up
        .map((item) => sanitizeText(item, "", 80))
        .filter(Boolean)
        .slice(0, 4)
    : [];

  return {
    ...chartSpec,
    chart_type: chartType,
    title,
    subtitle,
    takeaway,
    option,
    suggested_follow_up,
  };
}

module.exports = {
  validateChartSpec,
  buildFallbackChartSpec,
};