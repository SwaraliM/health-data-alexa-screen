import React, { useMemo, useRef } from "react";
import { FiChevronLeft, FiChevronRight } from "react-icons/fi";

const DAY_LABELS = ["M", "T", "W", "Th", "F", "S", "S"];

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const mean = (arr) => {
  if (!Array.isArray(arr) || arr.length === 0) return 0;
  return arr.reduce((sum, value) => sum + value, 0) / arr.length;
};

const stdDev = (arr) => {
  if (!Array.isArray(arr) || arr.length === 0) return 0;
  const avg = mean(arr);
  const variance = mean(arr.map((value) => (value - avg) ** 2));
  return Math.sqrt(variance);
};

const coeffVar = (arr) => {
  const avg = mean(arr);
  if (avg <= 0) return 1;
  return stdDev(arr) / avg;
};

const normalizeSeries = (arr) => {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const max = Math.max(...arr);
  const min = Math.min(...arr);
  if (max === min) return arr.map(() => 50);
  return arr.map((value) => ((value - min) / (max - min)) * 100);
};

const getPath = (points, width, height, xPadding = 0) => {
  if (!Array.isArray(points) || points.length === 0) return "";
  const drawableWidth = Math.max(1, width - xPadding * 2);
  const step = drawableWidth / Math.max(points.length - 1, 1);
  return points
    .map((point, index) => {
      const x = xPadding + index * step;
      const y = height - (point / 100) * height;
      return `${index === 0 ? "M" : "L"} ${x} ${y}`;
    })
    .join(" ");
};

const getHeadline = (score) => {
  if (score >= 78) return "Routine is very stable this week";
  if (score >= 60) return "Routine is mostly steady this week";
  if (score >= 40) return "Routine is mixed this week";
  return "Routine is less steady this week";
};

const getNeutralHeadline = (hasRoutineData) => {
  if (!hasRoutineData) return "Collecting more weekly routine data";
  return null;
};

const getRecommendation = ({ sleepGoalMetCount, hrvTrend, routineScore }) => {
  if (sleepGoalMetCount < 4) return "Try to keep bedtime and wake time within 30 minutes each day.";
  if (hrvTrend < 0) return "Keep activity light tomorrow and prioritize a full sleep window tonight.";
  if (routineScore < 55) return "A short walk at the same time daily can improve routine stability.";
  return "Keep this rhythm going with regular sleep and consistent daytime movement.";
};

const WeeklyCognitiveSummaryCard = ({
  weeklyActivity,
  weeklySleep,
  weeklyHeart,
  weeklyHrv,
  activePanelIndex = 0,
  onPanelChange,
  panelExplanations = {},
}) => {
  const touchStartXRef = useRef(null);
  const labels = weeklyActivity?.labels ?? DAY_LABELS;
  const stepSeries = Array.isArray(weeklyActivity?.steps) ? weeklyActivity.steps : [];
  const sleepMinutes = Array.isArray(weeklySleep?.minutes) ? weeklySleep.minutes : [];
  const sleepEfficiency = Array.isArray(weeklySleep?.efficiency) ? weeklySleep.efficiency : [];
  const sleepGoalMinutes = weeklySleep?.goalMinutes ?? 420;
  const restingHeart = Array.isArray(weeklyHeart?.restingHeartRate) ? weeklyHeart.restingHeartRate : [];
  const hrvRmssd = Array.isArray(weeklyHrv?.rmssd) ? weeklyHrv.rmssd : [];

  const metrics = useMemo(() => {
    const validSteps = stepSeries.filter((value) => Number.isFinite(value) && value >= 0);
    const validSleep = sleepMinutes.filter((value) => Number.isFinite(value) && value >= 0);
    const validHrv = hrvRmssd.filter((value) => Number.isFinite(value) && value > 0);
    const validRhr = restingHeart.filter((value) => Number.isFinite(value) && value > 0);

    const routineScore = clamp(
      Math.round(100 - ((coeffVar(validSteps) + coeffVar(validSleep)) / 2) * 100),
      0,
      100
    );

    const sleepGoalMetCount = validSleep.filter((minutes) => minutes >= sleepGoalMinutes).length;
    const avgEfficiency = validSleep.length > 0 ? Math.round(mean(sleepEfficiency)) : null;

    const hrvTrend = validHrv.length >= 2 ? validHrv[validHrv.length - 1] - validHrv[0] : null;
    const rhrTrend = validRhr.length >= 2 ? validRhr[validRhr.length - 1] - validRhr[0] : null;

    const normalizedRoutine = normalizeSeries(
      labels.map((_, index) => {
        const step = stepSeries[index] ?? 0;
        const sleep = sleepMinutes[index] ?? 0;
        const stepScale = validSteps.length ? (step / Math.max(...validSteps, 1)) * 100 : 0;
        const sleepScale = validSleep.length ? (sleep / Math.max(...validSleep, 1)) * 100 : 0;
        return (stepScale + sleepScale) / 2;
      })
    );

    return {
      routineScore,
      sleepGoalMetCount,
      avgEfficiency,
      hrvTrend,
      rhrTrend,
      normalizedRoutine,
      hasRecoveryData: validHrv.length > 0 || validRhr.length > 0,
      hasRoutineData: validSteps.length > 0 || validSleep.length > 0,
      hasSleepData: validSleep.length > 0,
    };
  }, [labels, stepSeries, sleepMinutes, sleepEfficiency, sleepGoalMinutes, hrvRmssd, restingHeart]);

  const axisPadding = 18;
  const routineChartWidth = 360;
  const routineChartHeight = 90;
  const recoveryChartWidth = 360;
  const recoveryChartHeight = 52;
  const routinePath = getPath(metrics.normalizedRoutine, routineChartWidth, routineChartHeight, axisPadding);
  const hrvPath = getPath(
    normalizeSeries(hrvRmssd.map((value) => value || 0)),
    recoveryChartWidth,
    recoveryChartHeight,
    axisPadding
  );
  const rhrPath = getPath(
    normalizeSeries(restingHeart.map((value) => value || 0)),
    recoveryChartWidth,
    recoveryChartHeight,
    axisPadding
  );
  const recommendation = getRecommendation({
    sleepGoalMetCount: metrics.sleepGoalMetCount,
    hrvTrend: metrics.hrvTrend ?? 0,
    routineScore: metrics.routineScore,
  });
  const confidence = metrics.hasRoutineData && metrics.hasSleepData && metrics.hasRecoveryData
    ? "Strong signal"
    : (metrics.hasRoutineData || metrics.hasSleepData || metrics.hasRecoveryData)
      ? "Limited data"
      : "Not enough data";

  const panelExplain = {
    consistencyExplain: panelExplanations.consistencyExplain
      || "Consistency score uses day-to-day variance in steps and sleep; steadier patterns are easier to sustain.",
    sleepExplain: panelExplanations.sleepExplain
      || "Nights meeting goal helps track sleep continuity, which supports stable daytime function.",
    recoveryExplain: panelExplanations.recoveryExplain
      || "HRV and resting heart trend together indicate recovery load; mixed signals suggest a lighter day.",
  };

  const panelSuggestion = [
    metrics.routineScore < 55
      ? "Set one fixed walk time daily to stabilize routine."
      : "Keep routine anchors consistent this week.",
    metrics.sleepGoalMetCount < 4
      ? "Aim for the same bedtime within a 30-minute window."
      : "Sleep continuity is improving. Keep schedule steady.",
    metrics.hrvTrend != null && metrics.hrvTrend < 0
      ? "Recovery looks lower. Keep activity lighter tomorrow."
      : "Recovery signals are steady. Maintain current pace.",
  ];

  const goPanel = (index) => {
    if (typeof onPanelChange !== "function") return;
    onPanelChange(Math.max(0, Math.min(2, index)));
  };

  const onTouchStart = (event) => {
    if (!event.touches || event.touches.length === 0) return;
    touchStartXRef.current = event.touches[0].clientX;
  };

  const onTouchEnd = (event) => {
    if (touchStartXRef.current == null || !event.changedTouches || event.changedTouches.length === 0) return;
    const delta = event.changedTouches[0].clientX - touchStartXRef.current;
    touchStartXRef.current = null;
    if (Math.abs(delta) < 40) return;
    if (delta < 0) goPanel(activePanelIndex + 1);
    else goPanel(activePanelIndex - 1);
  };

  return (
    <section className="ss-card ss-weekly-cognitive-card" aria-label="Weekly cognitive support summary">
      <h2>Weekly Cognitive Support Summary</h2>
      <p className="ss-weekly-headline">{getNeutralHeadline(metrics.hasRoutineData) || getHeadline(metrics.routineScore)}</p>
      <p className="ss-weekly-confidence">Data confidence: {confidence}</p>

      <div className="ss-weekly-nav" aria-label="Weekly summary navigation">
        <button
          type="button"
          className="ss-btn ss-btn-secondary ss-weekly-nav-btn"
          onClick={() => goPanel(activePanelIndex - 1)}
          disabled={activePanelIndex <= 0}
          aria-label="Show previous graph"
        >
          <FiChevronLeft aria-hidden="true" />
        </button>
        <p className="ss-weekly-nav-label">Graph {activePanelIndex + 1} of 3</p>
        <button
          type="button"
          className="ss-btn ss-btn-secondary ss-weekly-nav-btn"
          onClick={() => goPanel(activePanelIndex + 1)}
          disabled={activePanelIndex >= 2}
          aria-label="Show next graph"
        >
          <FiChevronRight aria-hidden="true" />
        </button>
      </div>

      <div className="ss-weekly-carousel" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        <div className="ss-weekly-track" style={{ transform: `translateX(-${activePanelIndex * 100}%)` }}>
        <article className="ss-weekly-slide ss-weekly-mini-panel" aria-label="Routine consistency panel">
          <h3>Routine Consistency</h3>
          {metrics.hasRoutineData ? (
            <>
              <p className="ss-weekly-mini-value">{metrics.routineScore}/100 stability</p>
              <svg viewBox="0 0 360 110" className="ss-weekly-sparkline" role="img" aria-label="Routine consistency trend">
                <path d={routinePath} className="ss-weekly-sparkline-path" />
                {metrics.normalizedRoutine.map((value, index) => {
                  const x = axisPadding + index * ((routineChartWidth - axisPadding * 2) / Math.max(metrics.normalizedRoutine.length - 1, 1));
                  const y = routineChartHeight - (value / 100) * routineChartHeight;
                  return <circle key={`routine-${index}`} cx={x} cy={y} r="3.5" className="ss-weekly-sparkline-dot" />;
                })}
                {labels.map((label, index) => (
                  <text
                    key={`routine-label-${label}-${index}`}
                    x={axisPadding + index * ((routineChartWidth - axisPadding * 2) / Math.max(labels.length - 1, 1))}
                    y="106"
                    textAnchor="middle"
                    className="ss-axis-label"
                  >
                    {label}
                  </text>
                ))}
              </svg>
            </>
          ) : (
            <p className="ss-helper-text">Not enough data yet for a routine trend line.</p>
          )}
          <p className="ss-weekly-explain">
            <strong>What this means:</strong> {panelExplain.consistencyExplain}
          </p>
          <p className="ss-suggestion-pill">Suggestion: {panelSuggestion[0]}</p>
        </article>

        <article className="ss-weekly-slide ss-weekly-mini-panel" aria-label="Sleep continuity panel">
          <h3>Sleep Continuity</h3>
          {metrics.hasSleepData ? (
            <>
              <p className="ss-weekly-mini-value">
                {metrics.sleepGoalMetCount}/7 nights met goal
                {metrics.avgEfficiency != null ? ` • ${metrics.avgEfficiency}% efficiency` : ""}
              </p>
              <div className="ss-weekly-bars" role="img" aria-label="Sleep duration and goal by day">
                {labels.map((label, index) => {
                  const minutes = sleepMinutes[index] ?? 0;
                  const maxValue = Math.max(...sleepMinutes, sleepGoalMinutes, 1);
                  const barHeight = clamp((minutes / maxValue) * 100, 0, 100);
                  const goalHeight = clamp((sleepGoalMinutes / maxValue) * 100, 0, 100);
                  return (
                    <div className="ss-weekly-bar-wrap" key={`sleep-${label}-${index}`}>
                      <span className="ss-weekly-goal-tick" style={{ bottom: `${goalHeight}%` }} />
                      <span className="ss-weekly-bar" style={{ height: `${barHeight}%` }} />
                      <span className="ss-axis-label">{label}</span>
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <p className="ss-helper-text">Not enough overnight data yet to show sleep continuity.</p>
          )}
          <p className="ss-weekly-explain">
            <strong>What this means:</strong> {panelExplain.sleepExplain}
          </p>
          <p className="ss-suggestion-pill">Suggestion: {panelSuggestion[1]}</p>
        </article>

        <article className="ss-weekly-slide ss-weekly-mini-panel" aria-label="Recovery trend panel">
          <h3>Recovery Trend</h3>
          {metrics.hasRecoveryData ? (
            <>
              <p className="ss-weekly-mini-value">
                HRV {metrics.hrvTrend == null ? "—" : metrics.hrvTrend >= 0 ? "up" : "down"} • RHR{" "}
                {metrics.rhrTrend == null ? "—" : metrics.rhrTrend <= 0 ? "improving" : "rising"}
              </p>
              <svg viewBox="0 0 360 82" className="ss-weekly-recovery-chart" role="img" aria-label="HRV and resting heart rate trends">
                <path d={hrvPath} className="ss-weekly-hrv-path" />
                <path d={rhrPath} className="ss-weekly-rhr-path" />
                {labels.map((label, index) => (
                  <text
                    key={`recovery-label-${label}-${index}`}
                    x={axisPadding + index * ((recoveryChartWidth - axisPadding * 2) / Math.max(labels.length - 1, 1))}
                    y="80"
                    textAnchor="middle"
                    className="ss-axis-label"
                  >
                    {label}
                  </text>
                ))}
              </svg>
            </>
          ) : (
            <p className="ss-helper-text">Not enough overnight data yet to show HRV recovery trend.</p>
          )}
          <p className="ss-weekly-explain">
            <strong>What this means:</strong> {panelExplain.recoveryExplain}
          </p>
          <p className="ss-suggestion-pill">Suggestion: {panelSuggestion[2]}</p>
        </article>
        </div>
      </div>

      <div className="ss-weekly-dots" aria-label="Weekly graph pages">
        {[0, 1, 2].map((index) => (
          <button
            key={index}
            type="button"
            className={`ss-weekly-dot ${activePanelIndex === index ? "active" : ""}`}
            onClick={() => goPanel(index)}
            aria-label={`Go to graph ${index + 1}`}
            aria-current={activePanelIndex === index ? "true" : "false"}
          />
        ))}
      </div>

      <p className="ss-suggestion-pill">Current focus: {recommendation}</p>
    </section>
  );
};

export default WeeklyCognitiveSummaryCard;
