import { applyPremiumHealthTheme } from "./echartsTheme";

const DASHBOARD_PALETTES = {
  steps: {
    primary: "#0EA5E9",
    secondary: "#14B8A6",
    accent: "#F59E0B",
  },
  sleep: {
    primary: "#5B6CFF",
    secondary: "#8B5CF6",
    accent: "#2DD4BF",
  },
  routine: {
    primary: "#F97316",
    secondary: "#F59E0B",
    accent: "#E11D48",
  },
  activity: {
    primary: "#14B8A6",
    secondary: "#0EA5E9",
    accent: "#F59E0B",
  },
};

function getPalette(metricKey) {
  return DASHBOARD_PALETTES[metricKey] || DASHBOARD_PALETTES.steps;
}

function toTitleCase(str) {
  return String(str || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function buildDashboardBarSpec({ labels, points, goal, unit, metricKey }) {
  const safeLabels = Array.isArray(labels) ? labels : [];
  const safeValues = Array.isArray(points) ? points.map((v) => Number(v) || 0) : [];
  const palette = getPalette(metricKey);
  const seriesName = toTitleCase(metricKey);
  const showLabels = safeValues.length <= 8;

  const option = {
    color: [palette.primary, palette.secondary, palette.accent],
    tooltip: { trigger: "axis" },
    grid: { left: 52, right: 20, top: 30, bottom: 40 },
    xAxis: {
      type: "category",
      data: safeLabels,
      axisLabel: { color: "#334155", fontSize: 14 },
      axisTick: { show: false },
    },
    yAxis: {
      type: "value",
      name: unit || "",
      axisLabel: { color: "#334155", fontSize: 14 },
      splitLine: { lineStyle: { color: "#E2E8F0" } },
    },
    series: [
      {
        type: "bar",
        name: seriesName,
        data: safeValues,
        itemStyle: {
          borderRadius: [10, 10, 0, 0],
          color: palette.primary,
        },
        label: {
          show: showLabels,
          position: "top",
          color: "#334155",
          fontSize: 12,
        },
        markLine: Number.isFinite(goal) && goal > 0
          ? {
              symbol: ["none", "none"],
              lineStyle: { type: "dashed", color: palette.secondary, width: 2 },
              label: { formatter: "Goal" },
              data: [{ yAxis: goal }],
            }
          : undefined,
      },
    ],
  };

  return {
    chart_type: "bar",
    title: `${seriesName} Trend`,
    subtitle: "",
    takeaway: "",
    highlight: null,
    suggested_follow_up: [],
    option: applyPremiumHealthTheme(option, { title: `${seriesName} Trend`, chartType: "bar" }),
  };
}

export { buildDashboardBarSpec };
