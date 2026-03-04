import React from "react";
import { Card, Typography } from "antd";
import { Tiny } from "@ant-design/plots";
import "../css/ring.css";
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

const Ring = ({ componentData, height, width, title, goal, current, options, insight, trend }) => {
  // Extract props from componentData if provided
  let finalProps = {};
  
  if (componentData) {
    finalProps = {
      height: height || extractValue(componentData, ['data.height', 'height']),
      width: width || extractValue(componentData, ['data.width', 'width']),
      title: title || extractValue(componentData, ['data.title', 'title']),
      goal: goal !== undefined ? goal : extractValue(componentData, ['data.goal', 'goal']),
      current: current !== undefined ? current : extractValue(componentData, ['data.current', 'current']),
      insight: insight || extractValue(componentData, ['data.insight', 'insight']),
      trend: trend !== undefined ? trend : extractValue(componentData, ['data.trend', 'trend']),
      options: options || extractValue(componentData, ['data.options', 'options']),
    };
  } else {
    finalProps = { height, width, title, goal, current, options, insight, trend };
  }
  
  const { title: finalTitle, goal: finalGoal, current: finalCurrent, insight: finalInsight, trend: finalTrend } = finalProps;
  const { heightPx, cardStyle, cleanedOptions } = sanitizeChartSize(componentData || finalProps, "container-fit");
  
  if (finalGoal === undefined || finalCurrent === undefined) {
    return (
      <div className="ring">
        <Card
          title={<h2 style={{ margin: 0, fontSize: "24px", fontWeight: "600" }}>{finalTitle || "Ring"}</h2>}
          bordered={false}
          size="small"
          style={{ ...cardStyle, ...cleanedOptions }}
          className="ring-card"
        >
          <div style={{ padding: "20px", color: "#8c8c8c" }}>Missing goal or current value</div>
        </Card>
      </div>
    );
  }
  
  let percent = (finalCurrent / finalGoal);
  let color = "#FF4D4F"; // Red - below 40%
  let status = "Needs Improvement";
  let statusColor = "#FF4D4F";

  if (percent >= 1) {
    percent = 1;
    color = "#52C41A"; // Green
    status = "Goal Achieved!";
    statusColor = "#52C41A";
  } else if (percent >= 0.8) {
    color = "#52C41A"; // Green
    status = "On Track";
    statusColor = "#52C41A";
  } else if (percent >= 0.4) {
    color = "#FAAD14"; // Yellow
    status = "Getting There";
    statusColor = "#FAAD14";
  }

  const remaining = Math.max(0, finalGoal - finalCurrent);
  const ringSize = Math.max(150, Math.min(230, Math.round((heightPx || 320) * 0.55)));

  const config = {
    percent: Math.max(percent, 0.0001),
    width: ringSize,
    height: ringSize,
    color: ["#EBF2FF", color],
    annotations: [
      {
        type: "text",
        style: {
          text: `${(percent * 100).toFixed(0)}%`,
          x: "50%",
          y: "50%",
          textAlign: "center",
          fontSize: 28,
          fontWeight: "bold",
          fill: color,
        },
      },
    ],
  };

  return (
    <div className="ring">
      <Card
        title={<h2 style={{ margin: 0, fontSize: "24px", fontWeight: "600", wordWrap: "break-word", overflowWrap: "break-word", maxWidth: "100%" }}>{finalTitle || "Ring"}</h2>}
        bordered={false}
        size="small"
        style={{ ...cardStyle, ...cleanedOptions }}
        className="ring-card"
      >
        <div style={{ textAlign: "center", marginBottom: "12px" }}>
          <Text strong style={{ fontSize: "20px", color: statusColor, fontWeight: "600" }}>
            {status}
          </Text>
        </div>
        
        <div className="ring-goal" style={{ fontSize: "16px", marginBottom: "8px" }}>
          <Text type="secondary" style={{ fontSize: "16px" }}>Goal: </Text>
          <Text strong style={{ fontSize: "18px" }}>{finalGoal.toLocaleString()}</Text>
        </div>
        
        <div className="ring-current" style={{ marginBottom: "12px" }}>
          <Text type="secondary" style={{ fontSize: "16px" }}>Current: </Text>
          <Text strong style={{ fontSize: "24px", fontWeight: "700" }}>{finalCurrent.toLocaleString()}</Text>
        </div>
        
        {remaining > 0 && (
          <div style={{ marginTop: "8px", marginBottom: "12px", fontSize: "16px", color: "#64748b" }}>
            <Text type="secondary" style={{ fontSize: "16px" }}>{remaining.toLocaleString()} remaining</Text>
          </div>
        )}
        
        <Tiny.Ring {...config} />
        
        {finalInsight && (
          <div style={{ 
            marginTop: "16px", 
            padding: "12px", 
            backgroundColor: "#f0f7ff", 
            borderRadius: "8px", 
            border: "1px solid #d6e4ff",
            maxWidth: "100%",
            boxSizing: "border-box"
          }}>
            <Text style={{ 
              fontSize: "16px", 
              color: "#1890ff", 
              lineHeight: "1.5",
              wordWrap: "break-word",
              overflowWrap: "break-word",
              whiteSpace: "normal",
              display: "block"
            }}>{finalInsight}</Text>
          </div>
        )}
        
        {finalTrend !== undefined && finalTrend !== null && (
          <div style={{ marginTop: "12px", fontSize: "16px" }}>
            <Text type="secondary" style={{ fontSize: "16px", fontWeight: "500" }}>
              {finalTrend > 0 ? "↑" : finalTrend < 0 ? "↓" : "→"} {Math.abs(finalTrend)}% vs last week
            </Text>
          </div>
        )}
      </Card>
    </div>
  );
};

export default Ring;
