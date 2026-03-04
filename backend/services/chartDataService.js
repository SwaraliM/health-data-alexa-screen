const { calculateStats, detectAnomalies } = require("./chartInsightService");
const { buildChartSpec } = require("./chartSpecService");

const asDateLabel = (dateStr) => {
  if (!dateStr) return "";
  const date = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(date.getTime())) return String(dateStr);
  return ["S", "M", "T", "W", "Th", "F", "S"][date.getDay()];
};

function toSeriesFromResource(payload, resourceKey, maxPoints = 30) {
  const arr = Array.isArray(payload?.[resourceKey]) ? payload[resourceKey].slice(-maxPoints) : [];
  return arr.map((item, idx) => ({
    date: item.dateTime || null,
    label: asDateLabel(item.dateTime) || String(idx + 1),
    value: Number(item.value) || 0,
  }));
}

function toSleepSeries(payload, maxPoints = 30) {
  const logs = Array.isArray(payload?.sleep) ? payload.sleep : [];
  const byDate = {};
  logs.forEach((entry) => {
    const date = entry.dateOfSleep || entry.dateTime;
    if (!date) return;
    const current = byDate[date];
    const mins = entry.minutesAsleep ?? Math.round((entry.duration || 0) / 60000);
    if (!current || entry.isMainSleep || mins > current.mins) {
      byDate[date] = {
        mins,
        efficiency: Number(entry.efficiency) || 0,
      };
    }
  });
  const dates = Object.keys(byDate).sort().slice(-maxPoints);
  return {
    sleep: dates.map((date) => ({
      date,
      label: asDateLabel(date),
      value: Math.round((byDate[date]?.mins || 0) / 60),
    })),
    routine: dates.map((date) => ({
      date,
      label: asDateLabel(date),
      value: Number(byDate[date]?.efficiency) || 0,
    })),
  };
}

function composeChartPayload({ metricType, timeframe, points, goal = null, unit = "" }) {
  const stats = calculateStats(points, goal);
  const anomalies = detectAnomalies(points);
  const chartSpec = buildChartSpec({ metricType, goal, anomalies });

  return {
    metricType,
    timeframe,
    unit,
    points,
    goal,
    stats,
    chartSpec,
    anomalies,
  };
}

function normalizeFrontendChartComponent(component = {}) {
  const name = component?.component || component?.type;
  if (!name || !component?.data || typeof component.data !== "object") return component;

  const data = component.data;
  if ((name === "CustomLineChart" || name === "CustomPie") && Array.isArray(data.data)) {
    const points = data.data.map((row, idx) => {
      const keys = Object.keys(row || {});
      const xKey = data.xField || data.xLabel || keys.find((k) => /date|time|day|label|x/i.test(k)) || keys[0];
      const yKey = data.yField || data.yLabel || keys.find((k) => Number.isFinite(Number(row[k])) && k !== xKey) || keys[1] || keys[0];
      return {
        date: row.date || row.dateTime || null,
        label: String(row[xKey] ?? idx + 1),
        value: Number(row[yKey]) || 0,
      };
    });
    const chartSpec = buildChartSpec({
      metricType: /sleep/i.test(data.title || "") ? "sleep" : "steps",
      goal: data.goalLine,
      anomalies: detectAnomalies(points),
    });

    return {
      ...component,
      data: {
        ...data,
        series: {
          points,
          unit: data.unit || "",
          goal: Number.isFinite(Number(data.goalLine)) ? Number(data.goalLine) : null,
          stats: calculateStats(points, data.goalLine),
        },
        chartSpec,
        xField: "label",
        yField: "value",
      },
      chartSummary: component.chartSummary || data.insight || data.title || "Health trend chart",
      explanationText: component.explanationText || data.insight || "This chart shows your health trend over time.",
    };
  }

  return component;
}

module.exports = {
  toSeriesFromResource,
  toSleepSeries,
  composeChartPayload,
  normalizeFrontendChartComponent,
};
