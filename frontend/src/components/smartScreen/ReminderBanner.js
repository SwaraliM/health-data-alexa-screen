import React from "react";
import { FiAlertCircle, FiNavigation, FiPackage, FiUser } from "react-icons/fi";

const ReminderBanner = ({
  type = "medication",
  onPrimary,
  onSecondary,
  onTertiary,
  timeText = "12:58 PM",
}) => {
  if (type === "movement") {
    return (
      <section className="ss-card ss-reminder-card" aria-label="Movement break reminder">
        <header className="ss-reminder-top">
          <p>{timeText}</p>
          <h1>Reminder</h1>
          <p className="ss-reminder-hi">
            <FiUser aria-hidden="true" /> Hi Amy!
          </p>
        </header>
        <div className="ss-reminder-body">
          <h2>
            <FiNavigation aria-hidden="true" /> Quick movement break
          </h2>
          <p>A light 10-15 min walk can help reach goal today.</p>
        </div>
        <div className="ss-inline-actions">
          <button type="button" className="ss-btn ss-btn-primary" onClick={onPrimary}>
            Start now
          </button>
          <button type="button" className="ss-btn ss-btn-secondary" onClick={onSecondary}>
            Remind me later
          </button>
          <button type="button" className="ss-btn ss-btn-ghost" onClick={onTertiary}>
            Dismiss
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="ss-card ss-reminder-card" aria-label="Medication reminder">
      <header className="ss-reminder-top">
        <p>{timeText}</p>
        <h1>Reminders</h1>
        <p className="ss-reminder-hi">
          <FiUser aria-hidden="true" /> Hi Amy!
        </p>
      </header>
      <div className="ss-reminder-body">
        <h2>
          <FiAlertCircle aria-hidden="true" /> Time to take your medication!
        </h2>
        <p>You have 2 pills scheduled now.</p>
        <div className="ss-reminder-meta">
          <span>Due: 1 PM</span>
          <span>Estimated time: 1 min</span>
        </div>
        <div className="ss-chip-row" aria-label="Scheduled medication">
          <span className="ss-chip">
            <FiPackage aria-hidden="true" /> Metformin (500mg) x1
          </span>
          <span className="ss-chip">
            <FiPackage aria-hidden="true" /> Vitamin D (1000 IU) x1
          </span>
        </div>
      </div>
      <div className="ss-inline-actions">
        <button type="button" className="ss-btn ss-btn-primary" onClick={onPrimary}>
          Mark taken
        </button>
        <button type="button" className="ss-btn ss-btn-secondary" onClick={onSecondary}>
          Snooze
        </button>
        <button type="button" className="ss-btn ss-btn-danger" onClick={onTertiary}>
          Skip
        </button>
      </div>
    </section>
  );
};

export default ReminderBanner;

