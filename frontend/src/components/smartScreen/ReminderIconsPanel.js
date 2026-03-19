import React from "react";
import { FiActivity, FiCalendar, FiDroplet, FiGrid, FiPackage } from "react-icons/fi";

const ICONS = {
  medications: FiPackage,
  activity: FiActivity,
  hydration: FiDroplet,
  appointments: FiCalendar,
  more: FiGrid,
};

const LABELS = {
  medications: "Medications",
  activity: "Activity",
  hydration: "Hydration",
  appointments: "Appointments",
  more: "More",
};

const ReminderIconsPanel = ({ categories = [], onOpenCategory }) => {
  return (
    <section className="ss-card ss-reminder-icons-panel" aria-label="Reminder categories">
      <header className="ss-reminder-icons-header">
        <h2>Reminders</h2>
      </header>
      <div className="ss-reminder-icons-grid">
        {categories.map((category) => {
          const Icon = ICONS[category.key] || FiGrid;
          const label = LABELS[category.key] || category.label;
          return (
            <button
              key={category.key}
              type="button"
              className="ss-reminder-icon-btn"
              onClick={() => onOpenCategory(category.key)}
              aria-label={`${label}${category.count > 0 ? ` (${category.count})` : ""}`}
            >
              <span className="ss-reminder-icon-wrap" aria-hidden="true">
                <Icon />
              </span>
              <span className="ss-reminder-icon-label">{label}</span>
              <span className="ss-reminder-icon-count">{Number(category.count) > 0 ? category.count : ""}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
};

export default ReminderIconsPanel;
