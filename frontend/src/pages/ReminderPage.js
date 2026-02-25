import React, { useState } from "react";
import { useSearchParams } from "react-router-dom";
import SmartScreenShell from "../components/smartScreen/SmartScreenShell";
import ReminderBanner from "../components/smartScreen/ReminderBanner";
import ModalDialog from "../components/smartScreen/ModalDialog";

const ReminderPage = () => {
  const [searchParams] = useSearchParams();
  const [showSkipConfirm, setShowSkipConfirm] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const variant = searchParams.get("type") === "movement" ? "movement" : "medication";

  const handlePrimary = () => {
    setStatusMessage(variant === "movement" ? "Great choice. Starting a short walk timer." : "Marked as taken. Nice job staying on track.");
  };

  const handleSecondary = () => {
    setStatusMessage(variant === "movement" ? "Okay. We will remind you later." : "Snoozed for 10 minutes.");
  };

  const handleTertiary = () => {
    if (variant === "medication") {
      setShowSkipConfirm(true);
      return;
    }
    setStatusMessage("Dismissed.");
  };

  return (
    <SmartScreenShell>
      <ReminderBanner
        type={variant}
        timeText={variant === "movement" ? "4:30 PM" : "12:58 PM"}
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

