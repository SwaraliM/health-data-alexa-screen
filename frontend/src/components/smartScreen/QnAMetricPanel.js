import React from "react";

export const StepsComparisonPanel = ({
  totalSteps = 38200,
  comparisonPercent = -7,
  currentWeekPercent = 46,
}) => {
  const width = Math.min(100, Math.max(0, currentWeekPercent));
  return (
    <section className="ss-card ss-qna-panel" aria-label="Steps comparison panel">
      <h2>Steps</h2>
      <p className="ss-big-number">{typeof totalSteps === "number" ? totalSteps.toLocaleString() : totalSteps} steps</p>
      <div className="ss-compare-bar" role="img" aria-label={`Steps comparison ${comparisonPercent}% vs last week`}>
        <span className="ss-compare-base" />
        <span className="ss-compare-current" style={{ width: `${width}%` }} />
      </div>
      <p className="ss-helper-text">{comparisonPercent >= 0 ? "+" : ""}{comparisonPercent}% vs last week</p>
    </section>
  );
};

export const SleepComparisonPanel = ({
  dailySleepData = [62, 74, 58, 71, 69, 77, 75],
  labels = ["M", "T", "W", "Th", "F", "S", "S"],
  averageChange = "+22 min avg",
  title,
}) => {
  const heights = Array.isArray(dailySleepData) && dailySleepData.length === 7 ? dailySleepData : [62, 74, 58, 71, 69, 77, 75];
  const maxH = Math.max(...heights, 1);
  const dayLabels = labels.length === 7 ? labels : ["M", "T", "W", "Th", "F", "S", "S"];

  return (
    <section className="ss-card ss-qna-panel" aria-label="Sleep comparison panel">
      <h2>{title != null ? title : `Sleep ${averageChange}`}</h2>
      <div className="ss-bars" role="img" aria-label="Sleep bar chart Monday through Sunday">
        {heights.map((height, index) => (
          <div className="ss-bar-wrap" key={`${dayLabels[index]}-${index}`}>
            <span className="ss-bar" style={{ height: `${(height / maxH) * 100}%` }} />
            <span className="ss-axis-label">{dayLabels[index]}</span>
          </div>
        ))}
      </div>
    </section>
  );
};

const QnAMetricPanel = () => null;

export default QnAMetricPanel;

