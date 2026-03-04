import React from "react";
import { FiAlertCircle, FiNavigation, FiPackage, FiUser, FiBell, FiDroplet, FiHeart, FiActivity } from "react-icons/fi";
import { FaPills, FaUserMd } from "react-icons/fa";

const ReminderBanner = ({
  type = "medication",
  onPrimary,
  onSecondary,
  onTertiary,
  timeText = "12:58 PM",
  userName = "Amy",
  medications = [],
  dueTime = "1 PM",
  estimatedTime = "1 min",
  movementSuggestion = "A light 10-15 min walk can help reach goal today.",
  customTitle = "General reminder",
  customDetail = "",
  pillVisual = { iconKey: "tablet" },
  visualKey = "bell",
}) => {
  const greeting = userName ? `Hi ${userName}!` : "Hi!";
  const pillIcon = pillVisual?.iconKey === "capsule"
    ? "💊"
    : pillVisual?.iconKey === "syrup"
      ? "🧴"
      : pillVisual?.iconKey === "injection"
        ? "💉"
        : pillVisual?.iconKey === "other"
          ? "🩺"
          : "💊";
  const renderHeroVisual = () => {
    const key = visualKey || (type === "medication" ? "pill" : type === "movement" ? "activity" : "bell");
    if (key === "pill") return <FaPills aria-hidden="true" />;
    if (key === "doctor") return <FaUserMd aria-hidden="true" />;
    if (key === "activity") return <FiActivity aria-hidden="true" />;
    if (key === "hydration") return <FiDroplet aria-hidden="true" />;
    if (key === "sleep") return <FiHeart aria-hidden="true" />;
    return <FiBell aria-hidden="true" />;
  };

  if (type === "movement") {
    return (
      <section className="ss-card ss-reminder-card" aria-label="Movement break reminder">
        <header className="ss-reminder-top">
          <p>{timeText}</p>
          <h1>Reminder</h1>
          <p className="ss-reminder-hi">
            <FiUser aria-hidden="true" /> {greeting}
          </p>
        </header>
        <div className="ss-reminder-body">
          <div className="ss-reminder-hero" aria-hidden="true">
            {renderHeroVisual()}
          </div>
          <h2>
            <FiNavigation aria-hidden="true" /> Quick movement break
          </h2>
          <p>{movementSuggestion}</p>
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

  if (type === "custom") {
    return (
      <section className="ss-card ss-reminder-card" aria-label="Custom reminder">
        <header className="ss-reminder-top">
          <p>{timeText}</p>
          <h1>Reminder</h1>
          <p className="ss-reminder-hi">
            <FiUser aria-hidden="true" /> {greeting}
          </p>
        </header>
        <div className="ss-reminder-body">
          <div className="ss-reminder-hero" aria-hidden="true">
            {renderHeroVisual()}
          </div>
          <h2>
            <FiBell aria-hidden="true" /> {customTitle}
          </h2>
          {customDetail ? <p>{customDetail}</p> : null}
          <div className="ss-reminder-meta">
            <span>Schedule: {dueTime}</span>
            <span><FiDroplet aria-hidden="true" /> Keep hydrated</span>
          </div>
        </div>
        <div className="ss-inline-actions">
          <button type="button" className="ss-btn ss-btn-primary" onClick={onPrimary}>
            Done
          </button>
          <button type="button" className="ss-btn ss-btn-secondary" onClick={onSecondary}>
            Snooze
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
          <FiUser aria-hidden="true" /> {greeting}
        </p>
      </header>
      <div className="ss-reminder-body">
        <div className="ss-reminder-hero" aria-hidden="true">
          {renderHeroVisual()}
        </div>
        <h2>
          <FiAlertCircle aria-hidden="true" /> Time to take your medication!
        </h2>
        <p className="ss-pill-visual" aria-label="Medication form">
          <span aria-hidden="true">{pillIcon}</span> Form: {pillVisual?.iconKey || "tablet"}
        </p>
        <p>You have {medications.length || 0} pill{(medications.length || 0) !== 1 ? "s" : ""} scheduled now.</p>
        <div className="ss-reminder-meta">
          <span>Due: {dueTime}</span>
          <span>Estimated time: {estimatedTime}</span>
        </div>
        <div className="ss-chip-row" aria-label="Scheduled medication">
          {medications.length > 0 ? (
            medications.map((med, i) => (
              <span key={i} className="ss-chip">
                <FiPackage aria-hidden="true" /> {med.name} ({med.dosage}) x{med.quantity ?? 1}
              </span>
            ))
          ) : (
            <span className="ss-chip">
              <FiPackage aria-hidden="true" /> No medications listed
            </span>
          )}
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
