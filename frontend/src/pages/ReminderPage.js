import React, { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import SmartScreenShell from "../components/smartScreen/SmartScreenShell";
import ReminderBanner from "../components/smartScreen/ReminderBanner";
import ModalDialog from "../components/smartScreen/ModalDialog";
import { getCurrentTime } from "../utils/getCurrentTime";

const getBaseUrl = () => {
  const isLocalDev = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
  return isLocalDev ? "http://localhost:5001" : (process.env.REACT_APP_FETCH_DATA_URL || "http://localhost:5001");
};

const ReminderPage = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [showSkipConfirm, setShowSkipConfirm] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [currentTime, setCurrentTime] = useState(getCurrentTime());
  const [reminderData, setReminderData] = useState(null);
  const [createDraft, setCreateDraft] = useState({
    title: "",
    recurrenceText: "every day at 7:00 PM",
    category: "custom",
  });

  const urlVariant = searchParams.get("type") === "movement" ? "movement" : "medication";
  const variant = reminderData?.action === "nudge"
    ? "movement"
    : (reminderData?.action === "reminder" || reminderData?.action === "reminderDue")
      ? (reminderData?.category && reminderData?.category !== "medication" ? "custom" : "medication")
      : urlVariant;
  const mode = searchParams.get("mode") === "create" ? "create" : "view";

  useEffect(() => {
    const raw = sessionStorage.getItem("reminderData");
    if (raw) {
      try {
        setReminderData(JSON.parse(raw));
      } catch (e) {
        console.error("ReminderPage: parse reminderData error", e);
      }
    }
  }, []);

  useEffect(() => {
    const t = setInterval(() => setCurrentTime(getCurrentTime()), 60000);
    return () => clearInterval(t);
  }, []);

  const username = reminderData?.username ?? localStorage.getItem("username") ?? "amy";
  const medication = reminderData?.medication;
  const medications = medication
    ? [{ name: medication.name, dosage: medication.dosage || "", quantity: 1 }]
    : [];
  const dueTime = reminderData?.dueTime ?? reminderData?.scheduleText ?? "1 PM";
  const movementSuggestion = reminderData?.movementSuggestion ?? "A light 10-15 min walk can help reach goal today.";
  const reminderId = reminderData?.reminderId;
  const customTitle = reminderData?.title ?? "General reminder";
  const customVisual = reminderData?.visualKey
    || (/doctor|appointment|clinic|hospital/i.test(customTitle) ? "doctor" : "bell");

  const returnToDashboard = (delayMs = 700) => {
    setTimeout(() => {
      navigate(`/dashboard/${username}`);
    }, delayMs);
  };

  const handlePrimary = async () => {
    if (variant === "medication" && medication?.id) {
      try {
        const res = await fetch(`${getBaseUrl()}/api/med/confirm/${medication.id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, taken: true }),
        });
        if (res.ok) {
          setStatusMessage("Marked as taken. Nice job staying on track.");
          sessionStorage.removeItem("reminderData");
          returnToDashboard();
        } else {
          setStatusMessage("Failed to confirm. Please try again.");
        }
      } catch (e) {
        console.error(e);
        setStatusMessage("Network error. Please try again.");
      }
    } else if (variant === "custom" && reminderId) {
      try {
        const res = await fetch(`${getBaseUrl()}/api/reminder/${username}/${reminderId}/ack`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "done" }),
        });
        if (res.ok) {
          setStatusMessage("Done. Nice follow-through.");
          sessionStorage.removeItem("reminderData");
          returnToDashboard();
        } else {
          setStatusMessage("Could not update reminder. Please try again.");
        }
      } catch (e) {
        console.error(e);
        setStatusMessage("Network error. Please try again.");
      }
    } else {
      setStatusMessage(variant === "movement" ? "Great choice. Starting a short walk timer." : "Marked as taken. Nice job staying on track.");
      sessionStorage.removeItem("reminderData");
      returnToDashboard();
    }
  };

  const handleSecondary = async () => {
    if (variant === "custom" && reminderId) {
      try {
        const res = await fetch(`${getBaseUrl()}/api/reminder/${username}/${reminderId}/ack`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "snoozed", snoozeMinutes: 10 }),
        });
        if (res.ok) {
          setStatusMessage("Snoozed for 10 minutes.");
          sessionStorage.removeItem("reminderData");
          returnToDashboard();
        } else {
          setStatusMessage("Could not snooze. Please try again.");
        }
      } catch (e) {
        console.error(e);
        setStatusMessage("Network error. Please try again.");
      }
      return;
    }
    setStatusMessage(variant === "movement" ? "Okay. We will remind you later." : "Snoozed for 10 minutes.");
    sessionStorage.removeItem("reminderData");
    returnToDashboard();
  };

  const handleTertiary = () => {
    if (variant === "medication") {
      setShowSkipConfirm(true);
      return;
    }
    setStatusMessage("Dismissed.");
    sessionStorage.removeItem("reminderData");
    returnToDashboard();
  };

  const handleCreateReminder = async (event) => {
    event.preventDefault();
    const usernameCreate = localStorage.getItem("username") ?? "amy";
    if (!createDraft.title.trim() || !createDraft.recurrenceText.trim()) {
      setStatusMessage("Please enter both reminder and schedule details.");
      return;
    }
    try {
      const res = await fetch(`${getBaseUrl()}/api/reminder/${usernameCreate}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: createDraft.title.trim(),
          category: createDraft.category,
          source: "app",
          recurrenceText: createDraft.recurrenceText.trim(),
        }),
      });
      if (!res.ok) {
        setStatusMessage("Could not create reminder. Please try again.");
        return;
      }
      const created = await res.json();
      setStatusMessage(`Reminder set for ${createDraft.recurrenceText}.`);
      setReminderData({
        action: "reminderDue",
        category: created.category,
        title: created.title,
        reminderId: created._id,
        scheduleText: createDraft.recurrenceText,
        visualKey: created?.payload?.visualKey || "bell",
        voicePrompt: `Reminder set: ${created.title}.`,
      });
    } catch (e) {
      console.error(e);
      setStatusMessage("Network error. Please try again.");
    }
  };

  if (mode === "create" && !reminderData) {
    return (
      <SmartScreenShell>
        <section className="ss-card ss-reminder-create" aria-label="Create reminder">
          <h2>Set Reminder</h2>
          <p>Set reminders on the smart screen. Alexa can set reminders too.</p>
          <form className="ss-form-grid" onSubmit={handleCreateReminder}>
            <label htmlFor="reminder-title">What should we remind you about?</label>
            <input
              id="reminder-title"
              className="ss-input"
              value={createDraft.title}
              onChange={(e) => setCreateDraft((d) => ({ ...d, title: e.target.value }))}
              placeholder="Doctor appointment"
            />
            <label htmlFor="reminder-when">When should we remind you?</label>
            <input
              id="reminder-when"
              className="ss-input"
              value={createDraft.recurrenceText}
              onChange={(e) => setCreateDraft((d) => ({ ...d, recurrenceText: e.target.value }))}
              placeholder="every day at 7:00 PM"
            />
            <label htmlFor="reminder-category">Reminder type</label>
            <select
              id="reminder-category"
              className="ss-input"
              value={createDraft.category}
              onChange={(e) => setCreateDraft((d) => ({ ...d, category: e.target.value }))}
            >
              <option value="custom">General</option>
              <option value="activity">Activity</option>
              <option value="hydration">Hydration</option>
              <option value="sleep">Sleep</option>
              <option value="task">Task</option>
            </select>
            <div className="ss-inline-actions">
              <button type="submit" className="ss-btn ss-btn-primary">Set reminder</button>
            </div>
          </form>
        </section>
        {statusMessage ? (
          <p className="ss-toast" role="status" aria-live="polite">
            {statusMessage}
          </p>
        ) : null}
      </SmartScreenShell>
    );
  }

  return (
    <SmartScreenShell>
      <ReminderBanner
        type={variant}
        timeText={currentTime}
        userName={username}
        medications={medications}
        dueTime={dueTime}
        estimatedTime="1 min"
        movementSuggestion={movementSuggestion}
        customTitle={customTitle}
        customDetail={reminderData?.voicePrompt || reminderData?.cta || ""}
        pillVisual={reminderData?.pillVisual || { iconKey: medication?.form || "tablet" }}
        visualKey={reminderData?.visualKey || customVisual}
        customCategory={reminderData?.category || "custom"}
        onPrimary={handlePrimary}
        onSecondary={handleSecondary}
        onTertiary={handleTertiary}
      />

      {statusMessage ? (
        <p className="ss-toast" role="status" aria-live="polite">
          {statusMessage}
        </p>
      ) : null}

      <ModalDialog title="Skip this dose?" open={showSkipConfirm} onClose={() => setShowSkipConfirm(false)}>
        <p>Skipping can impact your medication routine. Are you sure you want to skip this reminder?</p>
        <div className="ss-inline-actions">
          <button
            type="button"
            className="ss-btn ss-btn-danger"
            onClick={() => {
              setShowSkipConfirm(false);
              setStatusMessage("Dose skipped.");
              sessionStorage.removeItem("reminderData");
              returnToDashboard();
            }}
          >
            Yes, skip
          </button>
          <button type="button" className="ss-btn ss-btn-secondary" onClick={() => setShowSkipConfirm(false)}>
            Go back
          </button>
        </div>
      </ModalDialog>
    </SmartScreenShell>
  );
};

export default ReminderPage;
