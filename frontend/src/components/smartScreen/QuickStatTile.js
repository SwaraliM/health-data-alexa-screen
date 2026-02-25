import React from "react";

const QuickStatTile = ({ title, value, goalText, progressPercent, unit }) => {
  return (
    <article className="ss-card ss-tile" aria-label={`${title} quick stat`}>
      <h3>{title}</h3>
      <p className="ss-tile-value">
        {value}
        {unit ? <span className="ss-tile-unit"> {unit}</span> : null}
      </p>
      <p className="ss-tile-goal">{goalText}</p>
      <div
        className="ss-progress"
        role="img"
        aria-label={`${title} progress ${Math.round(progressPercent)} percent`}
      >
        <span className="ss-progress-fill" style={{ width: `${Math.min(100, Math.max(0, progressPercent))}%` }} />
      </div>
    </article>
  );
};

export default QuickStatTile;

