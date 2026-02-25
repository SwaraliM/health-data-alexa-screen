import React from "react";
import { Card, Typography } from "antd";
import { Line } from "@ant-design/plots";
import "../css/customLineChart.css";

const { Text } = Typography;

// Helper function to extract value from nested object using multiple possible paths
const extractValue = (obj, paths) => {
  for (const path of paths) {
    const keys = path.split('.');
    let value = obj;
    for (const key of keys) {
      if (value && typeof value === 'object' && key in value) {
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

const CustomLineChart = ({ componentData, height, width, title, data: propData, options, xLabel, yLabel, insight, goalLine, xField, yField }) => {
  // Extract all props from componentData if provided (direct GPT response)
  // This allows GPT to send data in any structure: {component: "X", data: {...}} or {component: "X", height: "...", data: [...]}
  let finalProps = {};
  
  if (componentData) {
    // If componentData.data exists, use it as base, otherwise use componentData itself
    const baseData = componentData.data || componentData;
    
    // Extract all possible props from any level
    finalProps = {
      height: height || extractValue(componentData, ['data.height', 'height']),
      width: width || extractValue(componentData, ['data.width', 'width']),
      title: title || extractValue(componentData, ['data.title', 'title']),
      data: propData || extractValue(componentData, ['data.data', 'data']),
      xLabel: xLabel || extractValue(componentData, ['data.xLabel', 'xLabel']),
      yLabel: yLabel || extractValue(componentData, ['data.yLabel', 'yLabel']),
      insight: insight || extractValue(componentData, ['data.insight', 'insight']),
      goalLine: goalLine !== undefined ? goalLine : extractValue(componentData, ['data.goalLine', 'goalLine']),
      xField: xField || extractValue(componentData, ['data.xField', 'xField']),
      yField: yField || extractValue(componentData, ['data.yField', 'yField']),
      options: options || extractValue(componentData, ['data.options', 'options']),
    };
  } else {
    // Fallback to direct props (backward compatibility)
    finalProps = { height, width, title, data: propData, xLabel, yLabel, insight, goalLine, xField, yField, options };
  }
  
  const { height: finalHeight, width: finalWidth, title: finalTitle, data: finalData, xLabel: finalXLabel, yLabel: finalYLabel, insight: finalInsight, goalLine: finalGoalLine, xField: finalXField, yField: finalYField } = finalProps;
  
  console.log("CustomLineChart - Extracted props:", finalProps);
  
  // Handle data array - find it wherever it might be
  let data = finalData;
  if (!data || !Array.isArray(data) || data.length === 0) {
    // Try to find data array at various locations
    if (componentData) {
      data = extractValue(componentData, ['data.data', 'data', 'componentData.data', 'componentData.data.data']);
    }
  }
  
  if (!data || !Array.isArray(data) || data.length === 0) {
    console.warn("CustomLineChart - No data provided");
    return (
      <Card
        className="line-card"
        title={finalTitle || "Chart"}
        size="small"
        style={{ height: finalHeight, width: finalWidth, ...finalProps.options }}
      >
        <Text type="secondary" style={{ fontSize: "16px" }}>No data available</Text>
      </Card>
    );
  }

  // Ensure we have valid dimensions
  const heightNum = parseInt(finalHeight, 10) || 400;
  const widthNum = parseInt(finalWidth, 10) || 600;
  const chartHeight = Math.max(heightNum * 0.75, 300);
  const chartWidth = Math.max(widthNum * 0.85, 500);
  
  console.log("CustomLineChart - Calculated dimensions:", { heightNum, widthNum, chartHeight, chartWidth });

  // Determine fields explicitly if provided, else intelligently detect common field names
  // Treat empty strings as undefined
  let xKey = (finalXField && finalXField.trim()) || null;
  let yKey = (finalYField && finalYField.trim()) || null;
  
  // Get available keys from first data point
  const keys = Object.keys(data[0] || {});
  console.log("CustomLineChart - Available keys:", keys);
  console.log("CustomLineChart - First data point:", data[0]);
  console.log("CustomLineChart - Provided fields:", { xField, yField, xKey, yKey });
  
  // Validate or detect fields
  if (!xKey || !yKey || !keys.includes(xKey) || !keys.includes(yKey)) {
    // Common x-axis field names (date/time related)
    const xFieldCandidates = ['date', 'datetime', 'time', 'day', 'week', 'month', 'x'];
    // Common y-axis field names (value/metric related)
    const yFieldCandidates = ['value', 'hours', 'minutes', 'minutesAsleep', 'steps', 'calories', 'heartRate', 'y'];
    
    // Try to find x field
    if (!xKey || !keys.includes(xKey)) {
      xKey = keys.find(k => xFieldCandidates.some(c => k.toLowerCase().includes(c.toLowerCase()))) || keys[0];
    }
    
    // Try to find y field (prefer numeric fields that aren't the x field)
    if (!yKey || !keys.includes(yKey) || yKey === xKey) {
      yKey = keys.find(k => 
        k !== xKey && (
          yFieldCandidates.some(c => k.toLowerCase().includes(c.toLowerCase())) ||
          typeof data[0][k] === 'number'
        )
      ) || keys.find(k => k !== xKey) || keys[1] || keys[0];
    }
  }
  
  // Final validation - ensure both fields exist and are valid
  if (!xKey || !yKey || !keys.includes(xKey) || !keys.includes(yKey)) {
    console.error("CustomLineChart - Invalid field detection:", { xKey, yKey, availableKeys: keys });
    return (
      <Card
        className="line-card"
        title={title}
        size="small"
        style={{ height, width, ...options }}
      >
        <Text type="danger" style={{ fontSize: "16px" }}>
          Error: Could not detect valid data fields. Available keys: {keys.join(", ")}
        </Text>
      </Card>
    );
  }
  
  console.log("CustomLineChart - Using fields:", { xKey, yKey, xLabel, yLabel });
  console.log("CustomLineChart - Field validation:", { 
    xKeyExists: keys.includes(xKey), 
    yKeyExists: keys.includes(yKey),
    xKeyValue: data[0]?.[xKey],
    yKeyValue: data[0]?.[yKey]
  });
  
  // Ensure fields are strings (not null/undefined)
  const chartXField = String(xKey);
  const chartYField = String(yKey);
  
  console.log("CustomLineChart - Final fields for config:", { chartXField, chartYField });
  
  const config = {
    height: chartHeight,
    width: chartWidth,
    data,
    xField: chartXField,
    yField: chartYField,
    autoFit: false, // Use explicit dimensions
    point: {
      shapeField: "circle",
      sizeField: 5,
      style: {
        fill: "#1890FF",
        stroke: "#fff",
        lineWidth: 2,
      },
    },
    line: {
      style: {
        lineWidth: 3,
        stroke: "#1890FF",
      },
    },
    interaction: {
      tooltip: {
        marker: true,
        formatter: (datum) => {
          const val = datum[chartYField];
          return {
            name: finalYLabel || chartYField,
            value: val !== undefined && val !== null ? Number(val).toLocaleString() : "N/A",
          };
        },
      },
    },
    annotations: finalGoalLine ? [
      {
        type: "line",
        start: ["min", finalGoalLine],
        end: ["max", finalGoalLine],
    style: {
          stroke: "#52C41A",
      lineWidth: 2,
          lineDash: [4, 4],
        },
        text: {
          content: `Goal: ${finalGoalLine}`,
          position: "end",
          style: {
            fill: "#52C41A",
            fontSize: 14,
            fontWeight: "600",
          },
        },
      },
    ] : [],
    axis: {
      x: { 
        labelFontSize: 16,
        title: finalXLabel || xKey,
        titleFontSize: 18,
        titleFontWeight: "600",
      },
      y: { 
        labelFontSize: 16,
        title: finalYLabel || yKey,
        titleFontSize: 18,
        titleFontWeight: "600",
        labelFormatter: (v) => Number(v).toLocaleString(),
      },
    },
    smooth: true,
    animation: {
      appear: {
        animation: "wave-in",
        duration: 1000,
      },
    },
  };

  console.log("CustomLineChart - Rendering with config:", { chartHeight, chartWidth, xKey, yKey, dataLength: data.length });
  
  return (
    <Card
      className="line-card"
      title={
        <div style={{ maxWidth: "100%", boxSizing: "border-box" }}>
          <h2 style={{ margin: 0, fontSize: "24px", fontWeight: "600", wordWrap: "break-word", overflowWrap: "break-word" }}>{finalTitle || "Chart"}</h2>
          {finalInsight && (
            <Text 
              type="secondary" 
              style={{ 
                fontSize: "16px", 
                fontWeight: "normal", 
                lineHeight: "1.5", 
                display: "block", 
                marginTop: "8px", 
                padding: "12px", 
                backgroundColor: "#f0f7ff", 
                borderRadius: "8px", 
                color: "#1890ff",
                maxWidth: "100%",
                wordWrap: "break-word",
                overflowWrap: "break-word",
                whiteSpace: "normal",
                boxSizing: "border-box"
              }}
            >
              {finalInsight}
            </Text>
          )}
        </div>
      }
      size="small"
      style={{ height: finalHeight, width: finalWidth, ...finalProps.options }}
    >
      <div 
        id={`line-chart-container-${title?.replace(/\s+/g, '-')}`}
        style={{ 
          width: `${chartWidth}px`, 
          height: `${chartHeight}px`, 
          display: "flex", 
          justifyContent: "center", 
          alignItems: "center",
          margin: "0 auto"
        }}
      >
        <Line {...config} />
      </div>
    </Card>
  );
};

export default CustomLineChart;
