import React, { useMemo } from "react";
import { FiActivity, FiBell, FiClock, FiDroplet, FiMoon, FiPackage, FiUserCheck } from "react-icons/fi";
import { FaUserMd } from "react-icons/fa";

const getVisualKey = (item) => {
  const key = item.visualKey || "";
  if (key) return key;
  const title = String(item.title || "").toLowerCase();
  if (item.type === "medication" || /pill|med|medicine|tablet|capsule/.test(title)) return "pill";
  if (/doctor|appointment|clinic|hospital/.test(title)) return "doctor";
  if (/walk|cardio|exercise|run|gym|workout/.test(title)) return "activity";
  if (/water|hydrate/.test(title)) return "hydration";
  if (/sleep|bed|nap/.test(title)) return "sleep";
  return "bell";
};

const iconFor = (visualKey) => {
  if (visualKey === "pill") return <FiPackage aria-hidden="true" />;
  if (visualKey === "doctor") return <FaUserMd aria-hidden="true" />;
  if (visualKey === "activity") return <FiActivity aria-hidden="true" />;
  if (visualKey === "hydration") return <FiDroplet aria-hidden="true" />;
  if (visualKey === "sleep") return <FiMoon aria-hidden="true" />;
  return <FiBell aria-hidden="true" />;
};

const toneFor = (visualKey) => {
  if (visualKey === "pill") return "medication";
  if (visualKey === "doctor") return "doctor";
  if (visualKey === "activity") return "activity";
  if (visualKey === "hydration") return "hydration";
  if (visualKey === "sleep") return "sleep";
  return "general";
};

const ComingUpRemindersCard = ({ medications = [], reminders = [], maxItems = 4 }) => {
  const combined = useMemo(() => {
    const medItems = Array.isArray(medications)
      ? medications.map((med, idx) => ({
          id: med._id || `med-${idx}`,
          type: "medication",
          title: med.name || "Medication reminder",
          visualKey: med.pillVisual?.iconKey === "capsule" ? "pill" : "pill",
          dueAt: med?.schedule?.rules?.[0]?.startAt || null,
          displayTime: med?.schedule?.rules?.[0]?.timeOfDay || med.nextDoseTime || med.time || "Scheduled",
          status: "scheduled",
        }))
      : [];

    const reminderItems = Array.isArray(reminders)
      ? reminders
          .filter((item) => item?.status !== "archived")
          .map((item, idx) => ({
            id: item._id || `rem-${idx}`,
            type: "reminder",
            title: item.title || "Reminder",
            visualKey: item?.payload?.visualKey || item.visualKey,
            dueAt: item.nextTriggerAt || item.currentDueAt || null,
            displayTime: item?.schedule?.rules?.[0]?.timeOfDay || "Scheduled",
            status: item.status || "active",
          }))
      : [];

    return [...medItems, ...reminderItems]
      .sort((a, b) => {
        const aTime = a.dueAt ? new Date(a.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
        const bTime = b.dueAt ? new Date(b.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
        return aTime - bTime;
      });
  }, [medications, reminders]);

  const visible = combined.slice(0, maxItems);
  const hiddenCount = Math.max(0, combined.length - visible.length);

  return (
    <section className="ss-card ss-coming-up-card" aria-label="Coming up reminders">
      <header className="ss-coming-up-header">
        <h2>Coming Up</h2>
        <p className="ss-coming-up-subtitle">
          <FiClock aria-hidden="true" /> Next reminders from your medication and reminder list
        </p>
      </header>

      {visible.length === 0 ? (
        <div className="ss-coming-up-empty">
          <FiUserCheck aria-hidden="true" />
          <p>No upcoming reminders.</p>
        </div>
      ) : (
        <ul className="ss-coming-up-list" aria-label="Upcoming reminders">
          {visible.map((item) => {
            const visualKey = getVisualKey(item);
            const tone = toneFor(visualKey);
            return (
              <li key={item.id} className={`ss-coming-up-item ss-coming-up-${tone}`}>
                <span className="ss-coming-up-icon">{iconFor(visualKey)}</span>
                <div className="ss-coming-up-meta">
                  <p className="ss-coming-up-title">{item.title}</p>
                  <p className="ss-coming-up-time">{item.displayTime}</p>
                </div>
                <span className={`ss-coming-up-chip ss-chip-${tone}`}>{item.type}</span>
              </li>
            );
          })}
        </ul>
      )}

      {hiddenCount > 0 ? <p className="ss-helper-text">+{hiddenCount} more reminders</p> : null}
    </section>
  );
};

export default ComingUpRemindersCard;
