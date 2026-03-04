import React, { useMemo, useState } from "react";
import { FiActivity, FiCalendar, FiChevronDown, FiClock, FiDroplet, FiPackage, FiX } from "react-icons/fi";

const TAB_META = {
  medications: { label: "Medications", icon: FiPackage },
  activity: { label: "Activity", icon: FiActivity },
  hydration: { label: "Hydration", icon: FiDroplet },
  appointments: { label: "Appointments", icon: FiCalendar },
};

const formatTime = (value) => {
  if (!value) return "Scheduled";
  if (value.includes("AM") || value.includes("PM")) return value;
  if (/^\d{1,2}:\d{2}$/.test(value)) {
    const [h, m] = value.split(":").map(Number);
    const period = h >= 12 ? "PM" : "AM";
    const hour = h % 12 || 12;
    return `${hour}:${String(m).padStart(2, "0")} ${period}`;
  }
  return value;
};

const RemindersModal = ({
  open,
  activeCategory,
  onCategoryChange,
  categories,
  reminders,
  onClose,
  onPrimaryAction,
  onSnooze,
  actionLoading = {},
}) => {
  const [expandedRowId, setExpandedRowId] = useState(null);

  const visibleItems = useMemo(
    () => reminders.filter((item) => item.categoryKey === activeCategory),
    [reminders, activeCategory]
  );

  if (!open) return null;

  return (
    <div className="ss-full-modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="ss-full-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Reminders"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="ss-full-modal-header">
          <button type="button" className="ss-icon-close" onClick={onClose} aria-label="Close reminders">
            <FiX />
          </button>
          <h2>Reminders</h2>
        </header>

        <div className="ss-segmented-tabs" role="tablist" aria-label="Reminder categories">
          {categories.map((category) => {
            const meta = TAB_META[category.key] || TAB_META.activity;
            const Icon = meta.icon;
            const isActive = category.key === activeCategory;
            return (
              <button
                key={category.key}
                type="button"
                role="tab"
                aria-selected={isActive}
                className={`ss-segmented-tab ${isActive ? "active" : ""}`}
                onClick={() => onCategoryChange(category.key)}
              >
                <Icon aria-hidden="true" />
                <span>{meta.label}</span>
              </button>
            );
          })}
        </div>

        <div className="ss-reminders-modal-body">
          {visibleItems.length === 0 ? (
            <p className="ss-helper-text">No reminders in this category.</p>
          ) : (
            <ul className="ss-reminders-list" aria-label="Reminders list">
              {visibleItems.map((item) => {
                const Icon = TAB_META[item.categoryKey]?.icon || FiClock;
                const itemLoading = Boolean(actionLoading[item.id]);
                const isExpanded = expandedRowId === item.id;
                const primaryLabel = item.categoryKey === "medications" ? "Mark taken" : "Done";
                return (
                  <li key={item.id} className="ss-reminder-row">
                    <div className="ss-reminder-row-main">
                      <span className="ss-reminder-row-icon" aria-hidden="true">
                        <Icon />
                      </span>
                      <div>
                        <p className="ss-reminder-row-title">{item.title}</p>
                        <p className="ss-reminder-row-time">{formatTime(item.displayTime)}</p>
                      </div>
                    </div>
                    <div className="ss-reminder-row-actions">
                      <button
                        type="button"
                        className="ss-btn ss-btn-primary"
                        onClick={() => onPrimaryAction(item)}
                        disabled={itemLoading}
                      >
                        {itemLoading ? "Saving..." : primaryLabel}
                      </button>
                      <button
                        type="button"
                        className="ss-btn ss-btn-secondary"
                        onClick={() => onSnooze(item)}
                        disabled={itemLoading}
                      >
                        Snooze
                      </button>
                    </div>
                    <button
                      type="button"
                      className="ss-reminder-details-toggle"
                      onClick={() => setExpandedRowId(isExpanded ? null : item.id)}
                      aria-expanded={isExpanded}
                    >
                      <span>Details</span>
                      <FiChevronDown className={isExpanded ? "expanded" : ""} />
                    </button>
                    {isExpanded ? (
                      <div className="ss-reminder-details">
                        <p><strong>Type:</strong> {item.categoryLabel}</p>
                        <p><strong>Status:</strong> {item.statusLabel}</p>
                        {item.nextTriggerAt ? <p><strong>Next alert:</strong> {new Date(item.nextTriggerAt).toLocaleString()}</p> : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
};

export default RemindersModal;
