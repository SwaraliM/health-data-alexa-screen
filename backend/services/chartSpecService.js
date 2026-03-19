/**
 * backend/services/chartSpecService.js
 *
 * Final validation/sanitization step before the frontend sees a chart.
 *
 * This version keeps the service backward-compatible while making report / overview
 * visuals look more polished on a chart-first smart-screen layout.
 */

const ALLOWED_TYPES = new Set([
  "bar",
  "grouped_bar",
  "line",
  "multi_line",
  "stacked_bar",
  "scatter",
  "area",
  "heatmap",
  "radar",
  "boxplot",
  "timeline",
  "gauge",
  "list_summary",
  "pie",
  "composed_summary",
]);

function sanitizeText(value, fallback = "", max = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : fallback;
}

function sanitizeItems(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((item) => sanitizeText(item, "", 110))
    .filter(Boolean)
    .slice(0, 8);
}

function sanitizeCards(cards = []) {
  return (Array.isArray(cards) ? cards : [])
    .slice(0, 6)
    .map((card) => ({
      label: sanitizeText(card?.label, "", 40),
      value: sanitizeText(card?.value, "", 40),
      subvalue: sanitizeText(card?.subvalue, "", 64),
    }))
    .filter((card) => card.label || card.value || card.subvalue);
}

function sanitizeGraphic(graphic = []) {
  if (!Array.isArray(graphic)) return [];
  return graphic.slice(0, 40).map((item) => sanitizeGraphicNode(item)).filter(Boolean);
}

function sanitizeGraphicNode(item) {
  if (!item || typeof item !== "object") return null;
  const cloned = { ...item };

  if (cloned.style && typeof cloned.style === "object") {
    cloned.style = { ...cloned.style };
    if (typeof cloned.style.text === "string") {
      cloned.style.text = sanitizeText(cloned.style.text, "", 240);
    }
  }

  if (cloned.shape && typeof cloned.shape === "object") {
    cloned.shape = { ...cloned.shape };
  }

  if (Array.isArray(cloned.children)) {
    cloned.children = cloned.children.map((child) => sanitizeGraphicNode(child)).filter(Boolean);
  }

  return cloned;
}

function sanitizeAxis(axis = {}, fallbackName = "") {
  if (!axis || typeof axis !== "object") return { type: "value", name: fallbackName };
  const cloned = { ...axis };
  if (Array.isArray(cloned.data)) cloned.data = cloned.data.slice(0, 60).map((v) => sanitizeText(v, "", 40));
  if (typeof cloned.name === "string") cloned.name = sanitizeText(cloned.name, fallbackName, 40);
  return cloned;
}

function sanitizeSeries(series = [], options = {}) {
  if (!Array.isArray(series)) return [];
  const maxSeries = options.preserveLength ? series.length : 8;
  const maxDataPoints = options.maxDataPoints ?? 120;
  return series.slice(0, maxSeries).map((item) => {
    if (!item || typeof item !== "object") return null;
    const cloned = { ...item };
    if (typeof cloned.name === "string") cloned.name = sanitizeText(cloned.name, "", 40);
    if (Array.isArray(cloned.data)) cloned.data = cloned.data.slice(0, maxDataPoints);
    if (cloned.itemStyle && typeof cloned.itemStyle === "object") cloned.itemStyle = { ...cloned.itemStyle };
    if (cloned.lineStyle && typeof cloned.lineStyle === "object") cloned.lineStyle = { ...cloned.lineStyle };
    if (cloned.areaStyle && typeof cloned.areaStyle === "object") cloned.areaStyle = { ...cloned.areaStyle };
    if (cloned.label && typeof cloned.label === "object") cloned.label = { ...cloned.label };
    if (cloned.emphasis && typeof cloned.emphasis === "object") cloned.emphasis = { ...cloned.emphasis };
    return cloned;
  }).filter(Boolean);
}

function defaultChartGrid(chartType) {
  if (chartType === "composed_summary" || chartType === "list_summary") {
    return { left: 28, right: 28, top: 24, bottom: 20, containLabel: true };
  }
  if (chartType === "scatter") {
    return { left: 64, right: 28, top: 56, bottom: 56, containLabel: true };
  }
  return { left: 56, right: 28, top: 70, bottom: 50, containLabel: true };
}

function buildFallbackChartSpec(title = "Health Summary", takeaway = "I could not prepare that chart.") {
  const cleanTitle = sanitizeText(title, "Health Summary", 80);
  const cleanTakeaway = sanitizeText(takeaway, "I could not prepare that chart.", 180);
  const option = buildSummaryOption({
    title: cleanTitle,
    subtitle: "Quick summary",
    takeaway: cleanTakeaway,
    items: [cleanTakeaway],
    cards: [],
    chartType: "list_summary",
  });

  return {
    chart_type: "list_summary",
    title: cleanTitle,
    subtitle: "Quick summary",
    takeaway: cleanTakeaway,
    option,
    suggested_follow_up: ["Try asking a simpler question."],
  };
}

function buildSummaryOption({ title, subtitle, takeaway, items, cards, chartType }) {
  const cleanItems = sanitizeItems(items);
  const cleanCards = sanitizeCards(cards);
  const graphic = [];

  const topY = 16;
  if (subtitle) {
    graphic.push({
      type: "text",
      left: "4%",
      top: topY,
      style: {
        text: sanitizeText(subtitle, "", 120),
        fontSize: 13,
        fontWeight: 500,
        fill: "#64748B",
      },
    });
  }

  graphic.push({
    type: "text",
    left: "4%",
    top: subtitle ? 36 : 20,
    style: {
      text: sanitizeText(takeaway || title, title, 220),
      fontSize: chartType === "composed_summary" ? 22 : 20,
      fontWeight: 700,
      lineHeight: 28,
      width: 1040,
      fill: "#0F172A",
    },
  });

  const cardTop = chartType === "composed_summary" ? 92 : 88;
  if (cleanCards.length) {
    cleanCards.slice(0, 4).forEach((card, idx) => {
      const left = 4 + (idx * 23.25);
      graphic.push({
        type: "group",
        left: `${left}%`,
        top: cardTop,
        children: [
          {
            type: "rect",
            shape: { x: 0, y: 0, width: 160, height: 82, r: 14 },
            style: { fill: "#F8FAFC", stroke: "#E2E8F0", lineWidth: 1 },
          },
          {
            type: "text",
            left: 12,
            top: 12,
            style: {
              text: card.label,
              fontSize: 13,
              fontWeight: 600,
              fill: "#475569",
            },
          },
          {
            type: "text",
            left: 12,
            top: 34,
            style: {
              text: card.value,
              fontSize: 22,
              fontWeight: 700,
              fill: "#0F172A",
            },
          },
          {
            type: "text",
            left: 12,
            top: 60,
            style: {
              text: card.subvalue || "",
              fontSize: 12,
              fill: "#64748B",
            },
          },
        ],
      });
    });
  }

  const storyTop = cleanCards.length ? 196 : 96;
  cleanItems.slice(0, 3).forEach((item, idx) => {
    graphic.push({
      type: "text",
      left: "4%",
      top: storyTop + (idx * 26),
      style: {
        text: `• ${item}`,
        fontSize: 16,
        lineHeight: 24,
        width: 1080,
        fill: "#334155",
      },
    });
  });

  if (cleanItems.length || cleanCards.length) {
    graphic.push({
      type: "line",
      shape: { x1: 42, y1: storyTop - 14, x2: 1120, y2: storyTop - 14 },
      style: { stroke: "#E2E8F0", lineWidth: 1 },
    });
  }

  return {
    items: cleanItems,
    cards: cleanCards,
    graphic: sanitizeGraphic(graphic),
    grid: defaultChartGrid(chartType),
    backgroundColor: "#FFFFFF",
  };
}

function mergeSummaryGraphics(option = {}, chartType, title, subtitle, takeaway) {
  const items = sanitizeItems(option.items || []);
  const cards = sanitizeCards(option.cards || []);
  const incomingGraphic = sanitizeGraphic(option.graphic || []);

  const polished = buildSummaryOption({
    title,
    subtitle,
    takeaway,
    items,
    cards,
    chartType,
  });

  // Keep user-provided graphics if they exist, but append them after the polished header/cards.
  if (incomingGraphic.length) {
    polished.graphic = sanitizeGraphic([...polished.graphic, ...incomingGraphic]);
  }

  return {
    ...option,
    ...polished,
  };
}

function validateChartSpec(chartSpec = {}, fallbackTitle = "Health Summary") {
  if (!chartSpec || typeof chartSpec !== "object") {
    return buildFallbackChartSpec(fallbackTitle, "The chart data was missing.");
  }

  const chart_type = ALLOWED_TYPES.has(String(chartSpec.chart_type || "").toLowerCase())
    ? String(chartSpec.chart_type).toLowerCase()
    : "list_summary";
  const title = sanitizeText(chartSpec.title, fallbackTitle, 80);
  const subtitle = sanitizeText(chartSpec.subtitle, "", 120);
  const takeaway = sanitizeText(chartSpec.takeaway, "Here is your summary.", 220);

  let option = chartSpec.option && typeof chartSpec.option === "object"
    ? { ...chartSpec.option }
    : buildFallbackChartSpec(title, takeaway).option;

  if (Array.isArray(option.color)) option.color = option.color.slice(0, 10);

  if (chart_type === "list_summary" || chart_type === "composed_summary") {
    option = mergeSummaryGraphics(option, chart_type, title, subtitle, takeaway);
  } else if (chart_type === "gauge") {
    if (!Array.isArray(option.series) || !option.series.length) {
      option.series = [{ type: "gauge", max: 100, data: [{ value: 0, name: "Progress" }] }];
    }
  } else if (chart_type === "heatmap" || chart_type === "radar") {
    // Heatmap/radar have specific option shape; keep as-is
    if (!option.series?.length && chart_type === "heatmap") {
      option.series = [{ type: "heatmap", data: [] }];
    }
    if (!option.series?.length && chart_type === "radar") {
      option.radar = option.radar || { indicator: [] };
      option.series = [{ type: "radar", data: [{ value: [], name: "Summary" }] }];
    }
  } else {
    if (option.xAxis) option.xAxis = sanitizeAxis(option.xAxis);
    if (option.yAxis) option.yAxis = sanitizeAxis(option.yAxis);
    if (option.legend && typeof option.legend === "object") option.legend = { ...option.legend };
    if (option.grid == null) option.grid = defaultChartGrid(chart_type);
    const preserveStructure = chart_type === "grouped_bar" || chart_type === "scatter";
    option.series = sanitizeSeries(option.series || [], {
      preserveLength: preserveStructure,
      maxDataPoints: preserveStructure && option.xAxis?.data?.length ? option.xAxis.data.length : 120,
    });
    if (chartSpec.option?.graphic || chartSpec.graphic) {
      option.graphic = sanitizeGraphic(chartSpec.option?.graphic || chartSpec.graphic || []);
    }
  }

  const suggested_follow_up = Array.isArray(chartSpec.suggested_follow_up)
    ? chartSpec.suggested_follow_up
        .map((item) => sanitizeText(item, "", 80))
        .filter(Boolean)
        .slice(0, 4)
    : [];

  return {
    ...chartSpec,
    chart_type,
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
