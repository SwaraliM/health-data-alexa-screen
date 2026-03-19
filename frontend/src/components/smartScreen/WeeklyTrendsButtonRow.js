import React from "react";
import { FiBarChart2, FiChevronRight } from "react-icons/fi";

const WeeklyTrendsButtonRow = ({ onOpen }) => {
  return (
    <button
      type="button"
      className="ss-card ss-weekly-trends-row"
      onClick={onOpen}
      aria-label="Open weekly trends"
    >
      <span className="ss-weekly-trends-icon" aria-hidden="true">
        <FiBarChart2 />
      </span>
      <span className="ss-weekly-trends-copy">
        <span className="ss-weekly-trends-title">Weekly Trends</span>
        <span className="ss-weekly-trends-subtitle">Tap to view insights</span>
      </span>
      <span className="ss-weekly-trends-chevron" aria-hidden="true">
        <FiChevronRight />
      </span>
    </button>
  );
};

export default WeeklyTrendsButtonRow;
