/**
 * backend/services/charts/chartPresetLibrary.js
 *
 * ECharts option builders for typed chart payloads.
 */

const CHART_COLORS = [
  "#3B82F6", "#10B981", "#F59E0B", "#EF4444",
  "#8B5CF6", "#06B6D4", "#F97316", "#84CC16",
];

const MAX_LABELS = 60;
const MAX_SERIES = 6;
const MAX_POINTS = 60;
const MAX_SLICES = 8;
const MAX_EVENTS = 20;
const MAX_INDICATORS = 8;

const BASE_TEXT_COLOR = "#0F172A";
const MUTED_TEXT_COLOR = "#64748B";
const GRID_LINE_COLOR = "#E2E8F0";
const AXIS_LINE_COLOR = "#CBD5E1";

function sanitizeText(value, max = 120, fallback = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : fallback;
}

function toNumber(value) {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeLabels(values, max = MAX_LABELS) {
  if (!Array.isArray(values)) return [];
  return values.slice(0, max).map((value) => sanitizeText(value, 40, ""));
}

function normalizeSeries(series, labelCount = 0, options = {}) {
  const maxSeries = options.maxSeries ?? MAX_SERIES;
  const maxPoints = options.maxPoints ?? MAX_POINTS;
  if (!Array.isArray(series)) return [];
  return series.slice(0, maxSeries).map((item, idx) => {
    const name = sanitizeText(item?.name, 40, "Series " + String(idx + 1));
    let data = Array.isArray(item?.data) ? item.data.slice(0, maxPoints) : [];
    data = data.map((value) => {
      const n = toNumber(value);
      return n == null ? null : n;
    });
    if (labelCount > 0) {
      if (data.length > labelCount) data = data.slice(0, labelCount);
      while (data.length < labelCount) data.push(null);
    }
    return { name, data };
  });
}

function normalizePoints(points, max = MAX_POINTS) {
  if (!Array.isArray(points)) return [];
  return points.slice(0, max).map((point) => {
    const x = toNumber(point?.x);
    const y = toNumber(point?.y);
    if (x == null || y == null) return null;
    const label = sanitizeText(point?.label, 30, "");
    return { x, y, label };
  }).filter(Boolean);
}

function normalizeHeatmapData(data, max = 400) {
  if (!Array.isArray(data)) return [];
  return data.slice(0, max).map((item) => {
    if (!Array.isArray(item) || item.length < 3) return null;
    const x = toNumber(item[0]);
    const y = toNumber(item[1]);
    const value = toNumber(item[2]);
    if (x == null || y == null || value == null) return null;
    return [x, y, value];
  }).filter(Boolean);
}

function normalizeRadarIndicators(indicators) {
  if (!Array.isArray(indicators)) return [];
  return indicators.slice(0, MAX_INDICATORS).map((item, idx) => {
    const name = sanitizeText(item?.name, 30, "Metric " + String(idx + 1));
    const max = toNumber(item?.max) ?? 0;
    return { name, max };
  });
}

function normalizeRadarSeries(series, indicatorCount) {
  if (!Array.isArray(series)) return [];
  return series.slice(0, 4).map((item, idx) => {
    const name = sanitizeText(item?.name, 40, "Series " + String(idx + 1));
    let values = Array.isArray(item?.values) ? item.values.slice(0, indicatorCount || MAX_INDICATORS) : [];
    values = values.map((value) => {
      const n = toNumber(value);
      return n == null ? null : n;
    });
    if (indicatorCount > 0) {
      if (values.length > indicatorCount) values = values.slice(0, indicatorCount);
      while (values.length < indicatorCount) values.push(null);
    }
    return { name, values };
  });
}

function normalizeSlices(slices) {
  if (!Array.isArray(slices)) return [];
  return slices.slice(0, MAX_SLICES).map((item, idx) => {
    const name = sanitizeText(item?.name, 40, "Slice " + String(idx + 1));
    const value = toNumber(item?.value);
    return value == null ? null : { name, value };
  }).filter(Boolean);
}

function normalizeEvents(events) {
  if (!Array.isArray(events)) return [];
  return events.slice(0, MAX_EVENTS).map((item) => ({
    date: sanitizeText(item?.date, 20, ""),
    label: sanitizeText(item?.label, 60, ""),
    value: toNumber(item?.value),
  }));
}

function normalizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => sanitizeText(item, 110, "")).filter(Boolean).slice(0, 8);
}

function normalizeCards(cards) {
  if (!Array.isArray(cards)) return [];
  return cards.slice(0, 4).map((card) => ({
    label: sanitizeText(card?.label, 40, ""),
    value: sanitizeText(card?.value, 40, ""),
    subvalue: sanitizeText(card?.subvalue, 64, ""),
  })).filter((card) => card.label || card.value || card.subvalue);
}

function gridFor(chartType) {
  if (chartType === "composed_summary" || chartType === "list_summary") {
    return { left: 28, right: 28, top: 24, bottom: 20, containLabel: true };
  }
  if (chartType === "scatter") {
    return { left: 64, right: 28, top: 56, bottom: 56, containLabel: true };
  }
  return { left: 56, right: 28, top: 70, bottom: 50, containLabel: true };
}

function baseOption(chartType, tooltipTrigger = "axis") {
  return {
    backgroundColor: "#FFFFFF",
    animation: false,
    color: CHART_COLORS,
    grid: gridFor(chartType),
    textStyle: {
      fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      color: BASE_TEXT_COLOR,
    },
    tooltip: { trigger: tooltipTrigger },
  };
}

function categoryAxis(labels = []) {
  return {
    type: "category",
    data: labels,
    axisLine: { lineStyle: { color: AXIS_LINE_COLOR } },
    axisTick: { show: false },
    axisLabel: { color: "#334155", fontSize: 12, margin: 10 },
    splitLine: { show: false },
  };
}

function valueAxis(name = "") {
  return {
    type: "value",
    name: name ? sanitizeText(name, 20, "") : "",
    nameTextStyle: { color: MUTED_TEXT_COLOR, fontSize: 12 },
    axisLine: { lineStyle: { color: AXIS_LINE_COLOR } },
    axisTick: { show: false },
    axisLabel: { color: "#334155", fontSize: 12, margin: 10 },
    splitLine: { lineStyle: { color: GRID_LINE_COLOR } },
  };
}

function buildBarOption(payload = {}, meta = {}) {
  const labels = normalizeLabels(payload.labels);
  const series = normalizeSeries(payload.series, labels.length, { maxSeries: 1 });
  const option = {
    ...baseOption("bar", "axis"),
    xAxis: categoryAxis(labels),
    yAxis: valueAxis(meta.unit || payload.unit),
    series: series.map((item) => ({
      type: "bar",
      name: item.name,
      data: item.data,
      barMaxWidth: 36,
      itemStyle: { borderRadius: [6, 6, 0, 0] },
    })),
  };

  const goalValue = toNumber(payload.goal_line);
  if (goalValue != null && option.series.length) {
    option.series[0].markLine = {
      symbol: ["none", "none"],
      label: { show: true, position: "end" },
      lineStyle: { type: "dashed", color: "#EF4444" },
      data: [{ yAxis: goalValue, name: "Goal" }],
    };
  }

  return option;
}

function buildGroupedBarOption(payload = {}, meta = {}) {
  const labels = normalizeLabels(payload.labels);
  const series = normalizeSeries(payload.series, labels.length, { maxSeries: 4 });
  return {
    ...baseOption("grouped_bar", "axis"),
    xAxis: categoryAxis(labels),
    yAxis: valueAxis(meta.unit || payload.unit),
    series: series.map((item) => ({
      type: "bar",
      name: item.name,
      data: item.data,
      barMaxWidth: 28,
    })),
  };
}

function buildLineOption(payload = {}, meta = {}) {
  const labels = normalizeLabels(payload.labels);
  const series = normalizeSeries(payload.series, labels.length, { maxSeries: 1 });
  const option = {
    ...baseOption("line", "axis"),
    xAxis: categoryAxis(labels),
    yAxis: valueAxis(meta.unit || payload.unit),
    series: series.map((item) => ({
      type: "line",
      name: item.name,
      data: item.data,
      smooth: true,
      showSymbol: false,
      symbol: "circle",
      symbolSize: 8,
      lineStyle: { width: 3 },
    })),
  };

  const refLine = payload.reference_line;
  const refValue = toNumber(refLine?.value);
  if (refValue != null && option.series.length) {
    option.series[0].markLine = {
      symbol: ["none", "none"],
      label: { show: true, position: "end" },
      lineStyle: { type: "dashed", color: "#94A3B8" },
      data: [{ yAxis: refValue, name: sanitizeText(refLine?.label, 40, "Reference") }],
    };
  }

  return option;
}

function buildMultiLineOption(payload = {}, meta = {}) {
  const labels = normalizeLabels(payload.labels);
  const series = normalizeSeries(payload.series, labels.length, { maxSeries: 4 });
  return {
    ...baseOption("multi_line", "axis"),
    xAxis: categoryAxis(labels),
    yAxis: valueAxis(meta.unit || payload.unit),
    series: series.map((item) => ({
      type: "line",
      name: item.name,
      data: item.data,
      smooth: true,
      showSymbol: false,
      symbol: "circle",
      symbolSize: 7,
      lineStyle: { width: 2.5 },
    })),
  };
}

function buildStackedBarOption(payload = {}, meta = {}) {
  const labels = normalizeLabels(payload.labels);
  const series = normalizeSeries(payload.series, labels.length, { maxSeries: 4 });
  return {
    ...baseOption("stacked_bar", "axis"),
    xAxis: categoryAxis(labels),
    yAxis: valueAxis(meta.unit || payload.unit),
    series: series.map((item) => ({
      type: "bar",
      name: item.name,
      data: item.data,
      stack: "total",
      barMaxWidth: 32,
    })),
  };
}

function buildAreaOption(payload = {}, meta = {}) {
  const labels = normalizeLabels(payload.labels);
  const series = normalizeSeries(payload.series, labels.length, { maxSeries: 1 });
  return {
    ...baseOption("area", "axis"),
    xAxis: categoryAxis(labels),
    yAxis: valueAxis(meta.unit || payload.unit),
    series: series.map((item) => ({
      type: "line",
      name: item.name,
      data: item.data,
      smooth: true,
      showSymbol: false,
      symbol: "circle",
      symbolSize: 7,
      lineStyle: { width: 2.5 },
      areaStyle: { opacity: 0.18 },
    })),
  };
}

function buildScatterOption(payload = {}, meta = {}) {
  const points = normalizePoints(payload.points);
  return {
    ...baseOption("scatter", "axis"),
    xAxis: valueAxis(payload.x_name || ""),
    yAxis: valueAxis(payload.y_name || ""),
    series: [{
      type: "scatter",
      name: sanitizeText(meta.title, 40, "Values"),
      data: points.map((point) => [point.x, point.y]),
      symbolSize: 10,
    }],
  };
}

function buildHeatmapOption(payload = {}, meta = {}) {
  const xLabels = normalizeLabels(payload.x_labels, 24);
  const yLabels = normalizeLabels(payload.y_labels, 14);
  const data = normalizeHeatmapData(payload.data, 400);
  const values = data.map((entry) => entry[2]).filter(Number.isFinite);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : min + 1;
  return {
    ...baseOption("heatmap", "axis"),
    xAxis: {
      ...categoryAxis(xLabels),
      axisLabel: { color: "#334155", fontSize: 11 },
    },
    yAxis: {
      ...categoryAxis(yLabels),
      axisLabel: { color: "#334155", fontSize: 11 },
    },
    visualMap: {
      min,
      max,
      calculable: false,
      orient: "horizontal",
      left: "center",
      bottom: 0,
      inRange: { color: ["#E0F2FE", "#0EA5E9", "#0369A1"] },
    },
    series: [{
      type: "heatmap",
      data,
    }],
  };
}

function buildRadarOption(payload = {}, meta = {}) {
  const indicators = normalizeRadarIndicators(payload.indicators);
  const series = normalizeRadarSeries(payload.series, indicators.length);
  return {
    ...baseOption("radar", "item"),
    radar: {
      indicator: indicators,
      radius: "62%",
      name: { color: "#334155", fontSize: 12 },
      splitLine: { lineStyle: { color: GRID_LINE_COLOR } },
      splitArea: { areaStyle: { color: ["#F8FAFC", "#FFFFFF"] } },
    },
    series: [{
      type: "radar",
      data: series.map((item) => ({ value: item.values, name: item.name })),
    }],
  };
}

function buildGaugeOption(payload = {}, meta = {}) {
  const min = toNumber(payload.min) ?? 0;
  const max = toNumber(payload.max) ?? 100;
  const rawValue = toNumber(payload.value);
  const value = rawValue == null ? min : Math.max(min, Math.min(max, rawValue));
  const unit = sanitizeText(payload.unit || meta.unit, 20, "");
  const detailText = unit ? "{value} " + unit : "{value}";
  return {
    ...baseOption("gauge", "item"),
    series: [{
      type: "gauge",
      min,
      max,
      radius: "92%",
      center: ["50%", "55%"],
      progress: { show: true, width: 16 },
      axisLine: { lineStyle: { width: 16 } },
      pointer: { show: false },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: { show: false },
      detail: {
        show: true,
        formatter: detailText,
        fontSize: 26,
        fontWeight: 700,
        offsetCenter: [0, "70%"],
      },
      data: [{ value, name: sanitizeText(meta.title, 24, "Progress") }],
    }],
  };
}

function buildPieOption(payload = {}, meta = {}) {
  const slices = normalizeSlices(payload.slices);
  return {
    ...baseOption("pie", "item"),
    legend: slices.length > 1 ? { bottom: 0 } : undefined,
    series: [{
      type: "pie",
      radius: ["40%", "72%"],
      data: slices,
    }],
  };
}

function buildTimelineOption(payload = {}, meta = {}) {
  const events = normalizeEvents(payload.events);
  const labels = events.map((event) => event.date);
  const data = events.map((event) => event.value == null ? null : event.value);
  return {
    ...baseOption("timeline", "axis"),
    xAxis: categoryAxis(labels),
    yAxis: valueAxis(meta.unit || payload.unit),
    series: [{
      type: "line",
      name: sanitizeText(meta.title, 40, "Timeline"),
      data,
      smooth: true,
      showSymbol: true,
      symbol: "circle",
      symbolSize: 7,
      lineStyle: { width: 2.5 },
    }],
  };
}

function buildListSummaryOption(payload = {}, meta = {}) {
  return {
    ...baseOption("list_summary", "item"),
    tooltip: { show: false },
    items: normalizeItems(payload.items),
    cards: normalizeCards(payload.cards),
  };
}

function buildComposedSummaryOption(payload = {}, meta = {}) {
  const option = {
    ...baseOption("composed_summary", "item"),
    tooltip: { show: false },
    items: normalizeItems(payload.items),
    cards: normalizeCards(payload.cards),
  };

  const chart = payload?.chart && typeof payload.chart === "object" ? payload.chart : null;
  if (chart) {
    const chartLabels = normalizeLabels(chart.labels, 24);
    const chartSeries = normalizeSeries(chart.series, chartLabels.length, { maxSeries: 2 });
    const chartType = chart.type === "line" ? "line" : "bar";
    option.tooltip = { trigger: "axis" };
    option.xAxis = categoryAxis(chartLabels);
    option.yAxis = valueAxis(meta.unit || payload.unit);
    option.series = chartSeries.map((item) => ({
      type: chartType,
      name: item.name,
      data: item.data,
      smooth: chartType === "line",
      showSymbol: chartType === "line",
      symbol: chartType === "line" ? "circle" : undefined,
      symbolSize: chartType === "line" ? 6 : undefined,
      lineStyle: chartType === "line" ? { width: 2 } : undefined,
      barMaxWidth: chartType === "bar" ? 24 : undefined,
    }));
  }

  return option;
}

module.exports = {
  CHART_COLORS,
  buildBarOption,
  buildGroupedBarOption,
  buildLineOption,
  buildMultiLineOption,
  buildStackedBarOption,
  buildAreaOption,
  buildScatterOption,
  buildHeatmapOption,
  buildRadarOption,
  buildGaugeOption,
  buildPieOption,
  buildTimelineOption,
  buildListSummaryOption,
  buildComposedSummaryOption,
};
