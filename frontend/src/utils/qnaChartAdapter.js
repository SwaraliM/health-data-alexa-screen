const isFiniteNumber = (value) => Number.isFinite(Number(value));

const pickXYKeys = (rows = [], preferredX, preferredY) => {
  const first = rows[0] || {};
  const keys = Object.keys(first);
  const xKey = preferredX && keys.includes(preferredX)
    ? preferredX
    : keys.find((key) => /date|time|day|label|x/i.test(key)) || keys[0];
  const yKey = preferredY && keys.includes(preferredY)
    ? preferredY
    : keys.find((key) => key !== xKey && rows.some((row) => isFiniteNumber(row[key]))) || keys.find((key) => key !== xKey) || keys[0];
  return { xKey, yKey };
};

const mapToSeries = (rows = [], preferredX, preferredY) => {
  const { xKey, yKey } = pickXYKeys(rows, preferredX, preferredY);
  return rows
    .map((row, idx) => ({
      date: row.date || row.dateTime || null,
      label: String(row?.[xKey] ?? idx + 1),
      value: Number(row?.[yKey]),
    }))
    .filter((point) => Number.isFinite(point.value));
};

export const adaptQnAComponentToTrendChart = (component = {}) => {
  const name = component?.component || component?.type;
  const data = component?.data && typeof component.data === "object" ? component.data : {};

  if (name === "CustomLineChart") {
    const rows = Array.isArray(data.series?.points)
      ? data.series.points
      : Array.isArray(data.points)
        ? data.points
        : Array.isArray(data.data)
          ? data.data
          : [];
    const series = rows.length > 0 && rows[0]?.value != null
      ? rows
      : mapToSeries(rows, data.xField, data.yField);

    return {
      type: "trend",
      chartType: data.chartSpec?.type || "line",
      series,
      unit: data.unit || "",
      spec: {
        type: data.chartSpec?.type || "line",
        showGoalLine: Number.isFinite(Number(data.goalLine || data.series?.goal)),
        goalLineValue: Number(data.goalLine || data.series?.goal),
        anomalies: data.chartSpec?.anomalies || [],
        interactions: { pointSelect: false, rangeSelect: false, anomalySelect: false },
      },
      title: data.title || "Trend",
      reason: series.length ? null : "No numeric series points found.",
    };
  }

  if (name === "CustomPie") {
    const rows = Array.isArray(data.data) ? data.data : [];
    const series = rows
      .map((row, idx) => ({
        label: String(row.type || row.label || row.name || idx + 1),
        value: Number(row.value),
        date: null,
      }))
      .filter((point) => Number.isFinite(point.value));

    return {
      type: "trend",
      chartType: "bar",
      series,
      unit: data.unit || "",
      spec: {
        type: "bar",
        showGoalLine: false,
        goalLineValue: null,
        anomalies: [],
        interactions: { pointSelect: false, rangeSelect: false, anomalySelect: false },
      },
      title: data.title || "Distribution",
      reason: series.length ? null : "No pie segments available.",
    };
  }

  return { type: "native", reason: null };
};
