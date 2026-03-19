import React from "react";
import { Statistic, Typography } from "antd";
import "../css/singleValue.css";
import CountUp from "react-countup";

const { Text } = Typography;

const formatter = (value) => <CountUp end={value} separator="," duration={1.5} />;

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

const SingleValue = ({ componentData, height, width, title, value, trend, unit, insight }) => {
  // Extract props from componentData if provided
  let finalProps = {};
  
  if (componentData) {
    finalProps = {
      height: height || extractValue(componentData, ['data.height', 'height']),
      width: width || extractValue(componentData, ['data.width', 'width']),
      title: title || extractValue(componentData, ['data.title', 'title']),
      value: value !== undefined ? value : extractValue(componentData, ['data.value', 'value']),
      trend: trend !== undefined ? trend : extractValue(componentData, ['data.trend', 'trend']),
      unit: unit || extractValue(componentData, ['data.unit', 'unit']),
      insight: insight || extractValue(componentData, ['data.insight', 'insight']),
    };
  } else {
    finalProps = { height, width, title, value, trend, unit, insight };
  }
  
  const { height: finalHeight, width: finalWidth, title: finalTitle, value: finalValue, trend: finalTrend, unit: finalUnit, insight: finalInsight } = finalProps;
  
  if (finalValue === undefined || finalValue === null) {
    return (
      <div className="single-value-component" style={{ height: finalHeight, width: finalWidth }}>
        <div style={{ padding: "20px", color: "#8c8c8c" }}>No value provided</div>
      </div>
    );
  }
  const trendColor = finalTrend > 0 ? "#52C41A" : finalTrend < 0 ? "#FF4D4F" : "#8C8C8C";
  const trendIcon = finalTrend > 0 ? "↑" : finalTrend < 0 ? "↓" : "→";

  return (
    <div className="single-value-component" style={{ height: finalHeight, width: finalWidth }}>
      <Statistic
        title={<span style={{ fontSize: "24px", fontWeight: "600" }}>{finalTitle || "Value"}</span>}
        value={finalValue}
        formatter={formatter}
        suffix={finalUnit}
        valueStyle={{ fontSize: "48px", fontWeight: "bold", color: "#1890ff" }}
      />
      {finalTrend !== undefined && finalTrend !== null && (
        <div style={{ marginTop: "12px", marginBottom: "12px" }}>
          <Text style={{ color: trendColor, fontSize: "18px", fontWeight: "600" }}>
            {trendIcon} {Math.abs(finalTrend)}% vs last week
          </Text>
        </div>
      )}
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
    </div>
  );
};

export default SingleValue;
