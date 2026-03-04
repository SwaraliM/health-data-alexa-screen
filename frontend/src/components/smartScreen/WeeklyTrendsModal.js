import React, { useMemo, useState } from "react";
import { FiActivity, FiBarChart2, FiChevronRight, FiMoon, FiTrendingUp, FiUserCheck, FiX } from "react-icons/fi";
import AskAIChipList from "./AskAIChipList";

const TABS = [
  { key: "steps", label: "Steps", icon: FiBarChart2 },
  { key: "sleep", label: "Sleep", icon: FiMoon },
  { key: "routine", label: "Routine", icon: FiUserCheck },
  { key: "activity", label: "Activity", icon: FiActivity },
];

const CHIPS = {
  steps: [
    "What caused the drop on Saturday?",
    "How far am I from my goal this week?",
    "What should I do tomorrow to improve?",
  ],
  sleep: [
    "Why was sleep lower mid-week?",
    "How can I improve sleep consistency?",
    "Is my sleep close to the goal?",
  ],
  routine: [
    "Which days were least consistent?",
    "How can I keep a steadier routine?",
    "What is one simple action for tomorrow?",
  ],
  activity: [
    "Which day had the strongest activity level?",
    "How can I avoid low activity days?",
    "What habit is helping most?",
  ],
};

const formatNumber = (value) => (Number.isFinite(value) ? Number(value).toLocaleString() : "0");

const buildPath = (data, width, height, padding) => {
  if (!Array.isArray(data) || data.length === 0) return "";
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = Math.max(1, max - min);
  const step = (width - padding * 2) / Math.max(data.length - 1, 1);

  return data
    .map((value, idx) => {
      const x = padding + idx * step;
      const y = padding + (height - padding * 2) * (1 - (value - min) / range);
      return `${idx === 0 ? "M" : "L"} ${x} ${y}`;
    })
    .join(" ");
};

const summarizeData = (data = [], goal = 0) => {
  const valid = data.filter((v) => Number.isFinite(v));
  if (valid.length === 0) {
    return { avg: 0, high: 0, low: 0, goal };
  }
  const total = valid.reduce((sum, value) => sum + value, 0);
  return {
    avg: Math.round(total / valid.length),
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
  onAskAi,
  aiAnswer,
  aiLoading,
}) => {
  const [question, setQuestion] = useState("");

  const selected = useMemo(() => chartData[activeTab] || { labels: [], points: [], unit: "" }, [chartData, activeTab]);
  const stats = useMemo(() => summarizeData(selected.points, selected.goal), [selected]);
  const chartPath = useMemo(() => buildPath(selected.points, 720, 300, 34), [selected.points]);

  if (!open) return null;

  const submitAsk = () => {
    const trimmed = question.trim();
    if (!trimmed) return;
    onAskAi(trimmed);
  };

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
            <>
              <svg viewBox="0 0 720 300" className="ss-trends-chart" role="img" aria-label={`${activeTab} ${timeframe} trend`}>
                <path className="ss-trends-chart-line" d={chartPath} />
                {selected.points.map((value, idx) => {
                  const max = Math.max(...selected.points, 1);
                  const min = Math.min(...selected.points, 0);
                  const range = Math.max(1, max - min);
                  const x = 34 + idx * ((720 - 68) / Math.max(selected.points.length - 1, 1));
                  const y = 34 + (300 - 68) * (1 - (value - min) / range);
                  return <circle key={`${selected.key}-${idx}`} cx={x} cy={y} r="6" className="ss-trends-chart-dot" />;
                })}
              </svg>
              <div className="ss-trends-x-axis" aria-hidden="true">
                {selected.labels.map((label) => (
                  <span key={`${activeTab}-${timeframe}-${label}`}>{label}</span>
                ))}
              </div>
            </>
          )}

          <div className="ss-trends-stats" aria-label="Trend summary stats">
            <p>Avg: <strong>{formatNumber(stats.avg)}</strong> {selected.unit}</p>
            <p>High: <strong>{formatNumber(stats.high)}</strong> {selected.unit}</p>
            <p>Low: <strong>{formatNumber(stats.low)}</strong> {selected.unit}</p>
            <p>Goal: <strong>{formatNumber(stats.goal)}</strong> {selected.unit}</p>
          </div>

          <div className="ss-trends-ai-box">
            <h3>Ask AI</h3>
            <AskAIChipList
              questions={CHIPS[activeTab] || []}
              onSelect={(selectedQuestion) => {
                setQuestion(selectedQuestion);
                onAskAi(selectedQuestion);
              }}
            />

            <div className="ss-trends-ai-row">
              <input
                className="ss-input"
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder="Ask about this trend"
                aria-label="Ask AI question"
              />
              <button type="button" className="ss-btn ss-btn-primary" onClick={submitAsk} disabled={aiLoading}>
                {aiLoading ? "Thinking..." : "Ask AI"}
              </button>
            </div>

            {aiAnswer ? (
              <div className="ss-trends-ai-answer" role="status" aria-live="polite">
                <p>{aiAnswer.answer}</p>
                {aiAnswer.confidence ? <p><strong>Confidence:</strong> {aiAnswer.confidence}</p> : null}
                {aiAnswer.notes ? <p><FiTrendingUp aria-hidden="true" /> {aiAnswer.notes}</p> : null}
              </div>
            ) : (
              <button type="button" className="ss-trends-suggested" onClick={() => onAskAi(CHIPS[activeTab]?.[0] || "What stands out this week?") }>
                <span>{CHIPS[activeTab]?.[0] || "What stands out this week?"}</span>
                <FiChevronRight />
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
};

export default WeeklyTrendsModal;
