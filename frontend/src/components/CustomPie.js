import React from "react";
import { Card, Typography } from "antd";
import { Pie } from "@ant-design/plots";
import "../css/customPie.css";
import { sanitizeChartSize } from "../utils/sanitizeChartSize";

const { Text } = Typography;

// Helper function to extract value from nested object
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

const CustomPie = ({ componentData, height, width, title, data: propData = [], options, insight }) => {
  // Extract props from componentData if provided
  let finalProps = {};
  
  if (componentData) {
    finalProps = {
      height: height || extractValue(componentData, ['data.height', 'height']),
      width: width || extractValue(componentData, ['data.width', 'width']),
      title: title || extractValue(componentData, ['data.title', 'title']),
      data: propData || extractValue(componentData, ['data.data', 'data']) || [],
      insight: insight || extractValue(componentData, ['data.insight', 'insight']),
      options: options || extractValue(componentData, ['data.options', 'options']),
    };
  } else {
    finalProps = { height, width, title, data: propData || [], insight, options };
  }
  
  const { title: finalTitle, data: finalData, insight: finalInsight } = finalProps;
  
  // Normalize data to use `type` key (backend may send `label`, `name`, or `type`)
  const normalizedData = (finalData || []).map((item) => ({
    type: item.type || item.label || item.name || "Unknown",
    value: item.value ?? 0,
  }));

  const { heightPx, cardStyle, cleanedOptions } = sanitizeChartSize(componentData || finalProps, "container-fit");
  const pieHeight = Math.max(heightPx - 30, 240);
  
  // Calculate total for percentage display
  const total = normalizedData.reduce((sum, item) => sum + item.value, 0);
  
  const config = {
    height: pieHeight,
    autoFit: true,
    data: normalizedData,
    angleField: "value",
    colorField: "type",
    radius: 0.8,
    innerRadius: 0.5,
    label: {
      type: "inner",
      offset: "-30%",
      content: ({ percent }) => `${(percent * 100).toFixed(0)}%`,
      style: {
        fontSize: 12,
        textAlign: "center",
        fontWeight: "bold",
      },
    },
    legend: {
      color: {
        title: false,
        position: "bottom",
        rowPadding: 8,
        itemName: {
          style: {
            fontSize: 12,
            fontWeight: "500",
          },
          formatter: (value) => {
            const text = String(value);
            return text.length > 14 ? `${text.slice(0, 14)}...` : text;
          },
        },
      },
    },
    tooltip: {
      formatter: (datum) => {
        return {
          name: datum.type,
          value: `${datum.value.toLocaleString()} (${((datum.value / total) * 100).toFixed(1)}%)`,
        };
      },
    },
    statistic: {
      title: {
        content: "Total",
        style: {
          fontSize: 14,
          fontWeight: "bold",
        },
      },
      content: {
        content: total.toLocaleString(),
        style: {
          fontSize: 18,
          fontWeight: "bold",
        },
      },
    },
    animation: {
      appear: {
        animation: "scale-in",
        duration: 1000,
      },
    },
  };

  return (
    <Card
    className="pie-card"
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
      style={{ ...cardStyle, ...cleanedOptions }}
    >
      <Pie {...config} />
    </Card>
  );
};

export default CustomPie;
