import React from "react";
import { FiSun } from "react-icons/fi";

const InsightCard = ({ onWhyClick, onAdjustGoalClick }) => {
  return (
    <section className="ss-card ss-insight-card" aria-label="Today's insight">
      <header className="ss-insight-header">
        <FiSun aria-hidden="true" />
        <h2>Today's Insight</h2>
      </header>
      <p>You slept for 6 hr 12 min</p>
      <p>Activity is moderate</p>
      <p className="ss-suggestion-pill" aria-label="Suggestion light cardio and hydrate">
        Suggestion: light cardio + hydrate
      </p>
      <div className="ss-inline-actions">
        <button type="button" className="ss-btn ss-btn-secondary" onClick={onWhyClick}>
          Why this suggestion?
        </button>
        <button type="button" className="ss-btn ss-btn-secondary" onClick={onAdjustGoalClick}>
          Adjust step goal
        </button>
      </div>
    </section>
  );
};

export default InsightCard;

