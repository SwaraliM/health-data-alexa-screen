function buildChartSpec({ metricType, goal, anomalies = [] }) {
  const typeMap = {
    steps: "line",
    activity: "area",
    sleep: "bar",
    routine: "bar",
    heart: "line",
    hrv: "line",
  };

  return {
    type: typeMap[metricType] || "line",
    xKey: "label",
    yKey: "value",
    showGoalLine: Number.isFinite(Number(goal)),
    goalLineValue: Number.isFinite(Number(goal)) ? Number(goal) : null,
    anomalies: Array.isArray(anomalies) ? anomalies : [],
    interactions: {
      pointSelect: true,
      rangeSelect: true,
      anomalySelect: true,
    },
  };
}

module.exports = {
  buildChartSpec,
};
