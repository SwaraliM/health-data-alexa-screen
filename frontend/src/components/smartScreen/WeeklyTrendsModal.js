import React, { useMemo } from "react";
import { FiActivity, FiBarChart2, FiMoon, FiUserCheck, FiX } from "react-icons/fi";
import EChartCard from "../EChartCard";
import { buildDashboardBarSpec } from "../../utils/dashboardChartSpec";

const TABS = [
  { key: "steps", label: "Steps", icon: FiBarChart2 },
  { key: "sleep", label: "Sleep", icon: FiMoon },
  { key: "routine", label: "Routine", icon: FiUserCheck },
  { key: "activity", label: "Activity", icon: FiActivity },
];

const formatNumber = (value, precision = 0) => (
  Number.isFinite(value)
    ? Number(value).toLocaleString(undefined, {
        minimumFractionDigits: precision,
        maximumFractionDigits: precision,
      })
    : "0"
);

const summarizeData = (data = [], goal = 0) => {
  const valid = data.filter((v) => Number.isFinite(v));
  if (valid.length === 0) {
    return { avg: 0, high: 0, low: 0, goal };
  }
  const total = valid.reduce((sum, value) => sum + value, 0);
  return {
    avg: total / valid.length,
    high: Math.max(...valid),
    low: Math.min(...valid),
    goal,
  };
};

const WeeklyTrendsModal = ({
  open,
  activeTab,
  onTabChange,
  timeframe,
  onTimeframeChange,
  chartData,
  onClose,
}) => {
  const selected = useMemo(() => chartData[activeTab] || { labels: [], points: [], unit: "" }, [chartData, activeTab]);
  const stats = useMemo(() => summarizeData(selected.points, selected.goal), [selected]);
  const valuePrecision = selected.precision ?? 0;
  const chartSpec = useMemo(
    () => buildDashboardBarSpec({ labels: selected.labels, points: selected.points, goal: selected.goal, unit: selected.unit, metricKey: activeTab }),
    [selected, activeTab]
  );

  if (!open) return null;
  return (
    <div className="ss-full-modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="ss-full-modal ss-full-modal-trends"
        role="dialog"
        aria-modal="true"
        aria-label="Weekly health trends"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="ss-full-modal-header">
          <button type="button" className="ss-icon-close" onClick={onClose} aria-label="Close weekly trends">
            <FiX />
          </button>
          <h2>Weekly Health Trends</h2>
        </header>

        <div className="ss-segmented-tabs" role="tablist" aria-label="Trend categories">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = tab.key === activeTab;
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={isActive}
                className={`ss-segmented-tab ${isActive ? "active" : ""}`}
                onClick={() => onTabChange(tab.key)}
              >
                <Icon aria-hidden="true" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        <div className="ss-trends-chart-shell">
          <div className="ss-timeframe-toggle" role="tablist" aria-label="Select timeframe">
            <button
              type="button"
              className={`ss-timeframe-btn ${timeframe === "week" ? "active" : ""}`}
              onClick={() => onTimeframeChange("week")}
            >
              Week
            </button>
            <button
              type="button"
              className={`ss-timeframe-btn ${timeframe === "month" ? "active" : ""}`}
              onClick={() => onTimeframeChange("month")}
            >
              Month
            </button>
          </div>

          {selected.points.length === 0 ? (
            <p className="ss-helper-text">Loading trend data...</p>
          ) : (
            <div className="ss-trends-echart-wrap" aria-label={`${activeTab} ${timeframe} trend`}>
              <EChartCard chartSpec={chartSpec} />
            </div>
          )}

          <div className="ss-trends-stats" aria-label="Trend summary stats">
            <p>Avg: <strong>{formatNumber(stats.avg, valuePrecision)}</strong> {selected.unit}</p>
            <p>High: <strong>{formatNumber(stats.high, valuePrecision)}</strong> {selected.unit}</p>
            <p>Low: <strong>{formatNumber(stats.low, valuePrecision)}</strong> {selected.unit}</p>
            <p>Goal: <strong>{formatNumber(stats.goal, valuePrecision)}</strong> {selected.unit}</p>
          </div>
        </div>
      </section>
    </div>
  );
};

export default WeeklyTrendsModal;
