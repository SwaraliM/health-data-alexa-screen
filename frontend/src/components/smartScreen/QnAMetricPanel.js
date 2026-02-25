import React from "react";

export const StepsComparisonPanel = () => {
  return (
    <section className="ss-card ss-qna-panel" aria-label="Steps comparison panel">
      <h2>Steps</h2>
      <p className="ss-big-number">38,200 steps</p>
      <div className="ss-compare-bar" role="img" aria-label="Steps comparison minus seven percent vs last week">
        <span className="ss-compare-base" />
        <span className="ss-compare-current" style={{ width: "46%" }} />
      </div>
      <p className="ss-helper-text">-7% vs last week</p>
    </section>
  );
};

export const SleepComparisonPanel = () => {
  const heights = [62, 74, 58, 71, 69, 77, 75];
  const labels = ["M", "T", "W", "Th", "F", "S", "S"];

  return (
    <section className="ss-card ss-qna-panel" aria-label="Sleep comparison panel">
      <h2>Sleep +22 min avg</h2>
      <div className="ss-bars" role="img" aria-label="Sleep bar chart Monday through Sunday">
        {heights.map((height, index) => (
          <div className="ss-bar-wrap" key={`${labels[index]}-${height}`}>
            <span className="ss-bar" style={{ height: `${height}%` }} />
            <span className="ss-axis-label">{labels[index]}</span>
          </div>
        ))}
      </div>
    </section>
  );
};

const QnAMetricPanel = () => null;

export default QnAMetricPanel;

