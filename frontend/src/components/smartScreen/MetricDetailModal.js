import React, { useMemo } from "react";
import { FiTrendingUp, FiX } from "react-icons/fi";
import EChartCard from "../EChartCard";
import { buildDashboardBarSpec } from "../../utils/dashboardChartSpec";

const formatValue = (value, precision = 0) => (
  Number.isFinite(value)
    ? Number(value).toLocaleString(undefined, {
        minimumFractionDigits: precision,
        maximumFractionDigits: precision,
      })
    : "0"
);

const summarizeTrend = (points = []) => {
  const valid = points.filter((point) => Number.isFinite(point));
  if (!valid.length) {
    return { average: 0, best: 0, latest: 0 };
  }

  return {
    average: valid.reduce((sum, value) => sum + value, 0) / valid.length,
    best: Math.max(...valid),
    latest: valid[valid.length - 1],
  };
};

const MetricDetailModal = ({
  open,
  metric,
  timeframe,
  onTimeframeChange,
  onClose,
}) => {
  const selectedTrend = useMemo(() => {
    if (!metric) return null;
    return timeframe === "month" ? metric.monthlyTrend : metric.weeklyTrend;
  }, [metric, timeframe]);

  const summary = useMemo(
    () => summarizeTrend(selectedTrend?.points || []),
    [selectedTrend]
  );

  const chartSpec = useMemo(() => {
    if (!metric || !selectedTrend) return null;
    return buildDashboardBarSpec({
      labels: selectedTrend.labels,
      points: selectedTrend.points,
      goal: metric.goalValue,
      unit: metric.unitLabel,
      metricKey: metric.key,
    });
  }, [metric, selectedTrend]);

  if (!open || !metric) return null;

  return (
    <div className="ss-full-modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="ss-full-modal ss-metric-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`${metric.title} details`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="ss-full-modal-header ss-metric-modal-header">
          <button type="button" className="ss-icon-close" onClick={onClose} aria-label={`Close ${metric.title} details`}>
            <FiX />
          </button>
          <div className="ss-metric-modal-heading">
            <p className="ss-metric-modal-eyebrow">{metric.eyebrow}</p>
            <h2>{metric.title}</h2>
          </div>
        </header>

        <section className="ss-metric-hero">
          <div>
            <p className="ss-metric-hero-label">Today</p>
            <p className="ss-metric-hero-value">
              {metric.displayValue}
              {metric.displayUnit ? <span>{` ${metric.displayUnit}`}</span> : null}
            </p>
            <p className="ss-metric-hero-copy">{metric.detailCopy}</p>
          </div>

          <div className="ss-metric-hero-actions">
            <div className="ss-timeframe-toggle" role="tablist" aria-label="Select detail timeframe">
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
            <p className="ss-metric-hero-goal">Goal: {metric.goalText}</p>
          </div>
        </section>

        <div className="ss-metric-modal-grid">
          <section className="ss-trends-chart-shell ss-metric-chart-panel">
            {selectedTrend?.points?.length ? (
              <div className="ss-trends-echart-wrap ss-metric-chart-wrap" aria-label={`${metric.title} ${timeframe} trend`}>
                <EChartCard chartSpec={chartSpec} />
              </div>
            ) : (
              <p className="ss-helper-text">Loading detail trend...</p>
            )}
          </section>

          <aside className="ss-metric-summary-panel">
            <div className="ss-metric-summary-card">
              <span className="ss-metric-summary-icon" aria-hidden="true">
                <FiTrendingUp />
              </span>
              <div>
                <p>Average</p>
                <strong>{formatValue(summary.average, metric.precision)} {metric.unitLabel}</strong>
              </div>
            </div>
            <div className="ss-metric-summary-card">
              <p>Best period</p>
              <strong>{formatValue(summary.best, metric.precision)} {metric.unitLabel}</strong>
            </div>
            <div className="ss-metric-summary-card">
              <p>Latest period</p>
              <strong>{formatValue(summary.latest, metric.precision)} {metric.unitLabel}</strong>
            </div>
            <div className="ss-metric-summary-note">
              <p>{metric.modalNote}</p>
            </div>
          </aside>
        </div>
      </section>
    </div>
  );
};

export default MetricDetailModal;
