import React from "react";
import { FiAlertCircle, FiCheckCircle, FiMinusCircle, FiPauseCircle } from "react-icons/fi";

const STATUS_COPY = {
  on_track: "On track",
  watch: "Watch today",
  needs_attention: "Needs attention",
  no_data: "No data yet",
};

const iconForStatus = (status) => {
  if (status === "on_track") return <FiCheckCircle aria-hidden="true" />;
  if (status === "watch") return <FiPauseCircle aria-hidden="true" />;
  if (status === "needs_attention") return <FiAlertCircle aria-hidden="true" />;
  return <FiMinusCircle aria-hidden="true" />;
};

const QuickStatTile = ({
  title,
  value,
  goalText = "",
  progressPercent,
  unit,
  status = "no_data",
  progressTone = "no-data",
}) => {
  const clampedProgress = Math.min(100, Math.max(0, Number(progressPercent) || 0));
  return (
    <article className="ss-card ss-tile" aria-label={`${title} quick stat`}>
      <h3>{title}</h3>
      <p className="ss-tile-value">
        {value}
        {unit ? <span className="ss-tile-unit"> {unit}</span> : null}
      </p>
      <p className={`ss-tile-status ss-status-${status}`} aria-label={`${title} status ${STATUS_COPY[status] || STATUS_COPY.no_data}`}>
        {iconForStatus(status)}
      </p>
      {goalText ? <p className="ss-tile-goal">{goalText}</p> : null}
      <div
        className={`ss-progress ss-progress-${progressTone}`}
        role="img"
        aria-label={`${title} progress ${Math.round(clampedProgress)} percent`}
      >
        <span className="ss-progress-fill" style={{ width: `${clampedProgress}%` }} />
      </div>
    </article>
  );
};

export default QuickStatTile;
