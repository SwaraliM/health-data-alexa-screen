import React from "react";
import { Card, Typography } from "antd";
import { Line } from "@ant-design/plots";
import "../css/customLineChart.css";
import { sanitizeChartSize } from "../utils/sanitizeChartSize";

const { Text } = Typography;

const extractValue = (obj, paths) => {
  for (const path of paths) {
    const keys = path.split(".");
    let value = obj;
    for (const key of keys) {
      if (value && typeof value === "object" && key in value) {
        value = value[key];
      } else {
        value = null;
        break;
      }
    }
    if (value !== null && value !== undefined) return value;
  }
  return null;
};

const pickFields = (data, xField, yField) => {
  const keys = Object.keys(data?.[0] || {});
  if (!keys.length) return { xKey: null, yKey: null };

  const xCandidates = ["date", "datetime", "time", "day", "week", "month", "label", "x"];
  const numericKeys = keys.filter((key) => {
    const numericCount = data.reduce((count, row) => count + (Number.isFinite(Number(row[key])) ? 1 : 0), 0);
    return numericCount > 0;
  });

  const validX = xField && keys.includes(xField) ? xField : null;
  const validY = yField && keys.includes(yField) ? yField : null;

  const xKey = validX || keys.find((key) => xCandidates.some((c) => key.toLowerCase().includes(c))) || keys[0];
  const yKey = (validY && validY !== xKey ? validY : null) || numericKeys.find((key) => key !== xKey) || keys.find((key) => key !== xKey) || xKey;
  return { xKey, yKey };
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const CustomLineChart = ({ componentData, height, width, title, data: propData, options, xLabel, yLabel, insight, goalLine, xField, yField }) => {
  let finalProps = {};
  if (componentData) {
    finalProps = {
      height: height || extractValue(componentData, ["data.height", "height"]),
      width: width || extractValue(componentData, ["data.width", "width"]),
      title: title || extractValue(componentData, ["data.title", "title"]),
      data: propData || extractValue(componentData, ["data.data", "data"]),
      xLabel: xLabel || extractValue(componentData, ["data.xLabel", "xLabel"]),
      yLabel: yLabel || extractValue(componentData, ["data.yLabel", "yLabel"]),
      insight: insight || extractValue(componentData, ["data.insight", "insight"]),
      goalLine: goalLine !== undefined ? goalLine : extractValue(componentData, ["data.goalLine", "goalLine"]),
      xField: xField || extractValue(componentData, ["data.xField", "xField"]),
      yField: yField || extractValue(componentData, ["data.yField", "yField"]),
      options: options || extractValue(componentData, ["data.options", "options"]),
    };
  } else {
    finalProps = { height, width, title, data: propData, options, xLabel, yLabel, insight, goalLine, xField, yField };
  }

  const chartData = Array.isArray(finalProps.data) ? finalProps.data : [];
  if (!chartData.length) {
    return (
      <Card className="line-card" title={finalProps.title || "Chart"} size="small" style={{ ...finalProps.options }}>
        <Text type="secondary" style={{ fontSize: "16px" }}>No data available</Text>
      </Card>
    );
  }

  const { xKey, yKey } = pickFields(chartData, finalProps.xField, finalProps.yField);
  if (!xKey || !yKey) {
    return (
      <Card className="line-card" title={finalProps.title || "Chart"} size="small" style={{ ...finalProps.options }}>
        <Text type="danger" style={{ fontSize: "16px" }}>Unable to identify chart fields from provided data.</Text>
      </Card>
    );
  }

  const normalized = chartData.map((item, index) => ({
    ...item,
    __x: item[xKey] ?? String(index + 1),
    __y: Number(item[yKey]),
  })).filter((item) => Number.isFinite(item.__y));

  if (!normalized.length) {
    return (
      <Card className="line-card" title={finalProps.title || "Chart"} size="small" style={{ ...finalProps.options }}>
        <Text type="secondary" style={{ fontSize: "16px" }}>No numeric values available for this chart.</Text>
      </Card>
    );
  }

  const values = normalized.map((item) => item.__y);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const range = maxValue - minValue;
  const padding = range === 0 ? Math.max(1, Math.abs(maxValue) * 0.1) : range * 0.1;
  const yMin = minValue - padding;
  const yMax = maxValue + padding;

  const { heightPx, cardStyle, cleanedOptions } = sanitizeChartSize(componentData || finalProps, "container-fit");
  const plotHeight = clamp(heightPx - 80, 240, 360);

  const config = {
    data: normalized,
    xField: "__x",
    yField: "__y",
    autoFit: true,
    height: plotHeight,
    smooth: true,
    point: {
      shape: "circle",
      size: 4,
      style: {
        fill: "#1954d8",
        stroke: "#ffffff",
        lineWidth: 1.5,
      },
    },
    line: {
      style: {
        stroke: "#1954d8",
        lineWidth: 2.5,
      },
    },
    scale: {
      y: {
        domain: [yMin, yMax],
        nice: true,
      },
    },
    axis: {
      x: {
        title: finalProps.xLabel || xKey,
        titleFontSize: 14,
        labelFontSize: 12,
        labelAutoHide: true,
        labelAutoRotate: false,
        labelFormatter: (value) => {
          const str = String(value);
          return str.length > 10 ? `${str.slice(0, 10)}...` : str;
        },
      },
      y: {
        title: finalProps.yLabel || yKey,
        titleFontSize: 14,
        labelFontSize: 12,
        labelFormatter: (value) => Number(value).toLocaleString(),
      },
    },
    interaction: {
      tooltip: {
        marker: true,
        formatter: (datum) => ({
          name: finalProps.yLabel || yKey,
          value: Number(datum.__y).toLocaleString(),
        }),
      },
    },
    paddingRight: 18,
    paddingLeft: 10,
    annotations: finalProps.goalLine != null ? [
      {
        type: "line",
        start: ["min", Number(finalProps.goalLine)],
        end: ["max", Number(finalProps.goalLine)],
        style: {
          stroke: "#2f855a",
          lineWidth: 2,
          lineDash: [4, 4],
        },
        text: {
          content: `Goal ${finalProps.goalLine}`,
          position: "end",
          style: {
            fill: "#2f855a",
            fontSize: 12,
            fontWeight: 600,
          },
        },
      },
    ] : [],
    animation: {
      appear: {
        animation: "fade-in",
        duration: 400,
      },
    },
  };

  return (
    <Card
      className="line-card"
      title={
        <div className="chart-title-wrap">
          <h2>{finalProps.title || "Chart"}</h2>
          {finalProps.insight && <Text className="chart-insight">{finalProps.insight}</Text>}
        </div>
      }
      size="small"
      style={{ ...cardStyle, ...cleanedOptions }}
    >
      <Line {...config} />
    </Card>
  );
};

export default CustomLineChart;
