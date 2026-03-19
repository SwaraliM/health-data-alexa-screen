import React from "react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Cell,
  LabelList,
} from "recharts";

/**
 * Colorful but readable bar chart used by the new QnA flow.
 *
 * Expected componentData shape:
 * {
 *   component: "CustomBarChart",
 *   data: {
 *     title,
 *     data: [{ label, value }, ...],
 *     xKey,
 *     yLabel,
 *     bars: [{ dataKey, name, fill }],
 *     highlightIndex,
 *     insight,
 *     theme: { palette: { ... } }
 *   }
 * }
 */
const CustomBarChart = ({ componentData }) => {
  const d = componentData?.data || {};
  const rows = Array.isArray(d.data) ? d.data : [];
  const xKey = d.xKey || "label";
  const bars = Array.isArray(d.bars) && d.bars.length ? d.bars : [{ dataKey: "value", name: "Value", fill: "#5B6CFF" }];
  const palette = d.palette || d.theme?.palette || {};
  const highlightIndex = Number.isFinite(Number(d.highlightIndex)) ? Number(d.highlightIndex) : null;

  const cardStyle = {
    width: "100%",
    height: "100%",
    minHeight: 320,
    padding: 16,
    borderRadius: 20,
    background: `linear-gradient(180deg, ${(palette.gradient && palette.gradient[0]) || palette.background || "#F6F8FF"} 0%, ${(palette.gradient && palette.gradient[1]) || "#FFFFFF"} 100%)`,
    border: `1px solid ${palette.primary || "#D9E1FF"}`,
    boxShadow: "0 10px 24px rgba(31, 42, 86, 0.08)",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  };

  const titleStyle = {
    margin: 0,
    fontSize: 18,
    lineHeight: 1.2,
    fontWeight: 700,
    color: palette.text || "#1F2A56",
  };

  const insightStyle = {
    margin: 0,
    fontSize: 14,
    lineHeight: 1.4,
    color: palette.text || "#1F2A56",
    opacity: 0.9,
  };

  const tooltipStyle = {
    borderRadius: 14,
    border: `1px solid ${palette.primary || "#5B6CFF"}`,
    boxShadow: "0 8px 24px rgba(31, 42, 86, 0.12)",
    backgroundColor: "#FFFFFF",
    color: palette.text || "#1F2A56",
  };

  return (
    <div style={cardStyle}>
      {d.title ? <h3 style={titleStyle}>{d.title}</h3> : null}
      <div style={{ flex: 1, minHeight: 240 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 20, right: 12, left: 0, bottom: 12 }} barCategoryGap={18}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(31, 42, 86, 0.10)" />
            <XAxis
              dataKey={xKey}
              tick={{ fill: palette.text || "#1F2A56", fontSize: 13 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tick={{ fill: palette.text || "#1F2A56", fontSize: 12 }}
              axisLine={false}
              tickLine={false}
              width={44}
            />
            <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "rgba(91, 108, 255, 0.08)" }} />
            {bars.map((bar, index) => (
              <Bar
                key={`${bar.dataKey}-${index}`}
                dataKey={bar.dataKey}
                name={bar.name}
                radius={[12, 12, 0, 0]}
                fill={bar.fill || palette.primary || "#5B6CFF"}
                maxBarSize={54}
              >
                {rows.map((entry, rowIndex) => {
                  const colors = palette.series || [bar.fill || palette.primary || "#5B6CFF"];
                  const baseColor = colors[rowIndex % colors.length] || bar.fill || palette.primary || "#5B6CFF";
                  const fill = highlightIndex === rowIndex
                    ? (palette.accent || "#FFB703")
                    : (index === 0 ? baseColor : (bar.fill || palette.secondary || palette.primary || "#5B6CFF"));
                  return <Cell key={`${index}-${rowIndex}`} fill={fill} />;
                })}
                <LabelList dataKey={bar.dataKey} position="top" fill={palette.text || "#1F2A56"} fontSize={12} />
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      {d.insight ? <p style={insightStyle}>{d.insight}</p> : null}
    </div>
  );
};

export default CustomBarChart;