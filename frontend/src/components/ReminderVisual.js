import React from "react";
import { FiActivity, FiBell, FiHeart, FiUserCheck } from "react-icons/fi";
import "../css/reminderVisual.css";

const safeColor = (value, fallback) => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(trimmed) ? trimmed : fallback;
};

const buildPillLabel = (pillVisual = {}, medicationName = "medication") => {
  const form = pillVisual?.iconKey || "tablet";
  return `${medicationName} ${form}`;
};

const ReminderVisual = ({
  visualKey = "bell",
  pillVisual = { iconKey: "tablet", accentColor: "#5b8def" },
  medicationName = "Medication",
  size = "large",
}) => {
  const accentColor = safeColor(pillVisual?.accentColor, "#5b8def");
  const pillKind = pillVisual?.iconKey || "tablet";
  const shellClass = `rv-shell rv-shell-${size}`;

  if (visualKey === "pill") {
    return (
      <div className={shellClass} aria-label={buildPillLabel(pillVisual, medicationName)} role="img">
        <div className={`rv-pill rv-pill-${pillKind}`} style={{ "--rv-accent": accentColor }}>
          {pillKind === "capsule" ? <span className="rv-pill-split" aria-hidden="true" /> : null}
          {pillKind === "tablet" ? <span className="rv-pill-score" aria-hidden="true" /> : null}
          {pillKind === "injection" ? (
            <>
              <span className="rv-syringe-body" aria-hidden="true" />
              <span className="rv-syringe-needle" aria-hidden="true" />
            </>
          ) : null}
          {pillKind === "syrup" ? (
            <>
              <span className="rv-bottle-cap" aria-hidden="true" />
              <span className="rv-bottle-liquid" aria-hidden="true" />
            </>
          ) : null}
          {pillKind === "other" ? <span className="rv-pill-dot" aria-hidden="true" /> : null}
        </div>
      </div>
    );
  }

  if (visualKey === "hydration") {
    return (
      <div className={shellClass} aria-label="Glass of water" role="img">
        <div className="rv-water-glass">
          <span className="rv-water-fill" aria-hidden="true" />
          <span className="rv-water-shine" aria-hidden="true" />
        </div>
      </div>
    );
  }

  const iconClass = `${shellClass} rv-icon-shell`;
  if (visualKey === "activity") return <div className={iconClass} aria-label="Activity reminder" role="img"><FiActivity /></div>;
  if (visualKey === "sleep") return <div className={iconClass} aria-label="Sleep reminder" role="img"><FiHeart /></div>;
  if (visualKey === "doctor") return <div className={iconClass} aria-label="Appointment reminder" role="img"><FiUserCheck /></div>;
  return <div className={iconClass} aria-label="Reminder" role="img"><FiBell /></div>;
};

export default ReminderVisual;
