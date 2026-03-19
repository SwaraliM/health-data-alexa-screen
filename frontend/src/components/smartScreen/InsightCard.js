import React from "react";
import { FiSun } from "react-icons/fi";

const InsightCard = ({
  sleepText = "6h 12m",
  activityText = "Moderate",
  suggestionText = "light cardio + hydrate",
}) => {
  return (
    <section className="ss-card ss-insight-card" aria-label="Today's insight">
      <header className="ss-insight-header">
        <FiSun aria-hidden="true" />
        <h2>Today's Insight</h2>
      </header>
      <div className="ss-insight-content">
        <p><strong>Sleep:</strong> {sleepText}</p>
        <p><strong>Activity:</strong> {activityText}</p>
        <div className="ss-suggestion-pill-row">
          <p className="ss-suggestion-pill" aria-label={`Suggestion ${suggestionText}`}>
            Suggestion: {suggestionText}
          </p>
        </div>
      </div>
    </section>
  );
};

export default InsightCard;
