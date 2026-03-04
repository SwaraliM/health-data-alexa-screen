import React, { useState, useEffect } from 'react';
import '../css/reminderNudgeOverlay.css';

const getBaseUrl = () => {
  const isLocalDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  return isLocalDev ? 'http://localhost:5001' : (process.env.REACT_APP_FETCH_DATA_URL || 'http://localhost:5001');
};

const ReminderNudgeOverlay = () => {
  const [reminder, setReminder] = useState(null);
  const [nudge, setNudge] = useState(null);
  const [moodPrompt, setMoodPrompt] = useState(false);
  const [showSkipConfirm, setShowSkipConfirm] = useState(false);

  const username = reminder?.username ?? nudge?.username ?? localStorage.getItem('username') ?? 'amy';

  useEffect(() => {
    const handleMedicationReminder = (event) => {
      setReminder({ ...event.detail, username: event.detail.username ?? localStorage.getItem('username') ?? 'amy' });
    };

    const handleReminderDue = (event) => {
      const detail = event.detail || {};
      setReminder({ ...detail, username: detail.username ?? localStorage.getItem('username') ?? 'amy' });
    };

    const handleExerciseNudge = (event) => {
      const detail = event.detail || {};
      setNudge(detail);
      if (detail.promptMood) {
        setMoodPrompt(true);
      }
    };

    window.addEventListener('medicationReminder', handleMedicationReminder);
    window.addEventListener('reminderDue', handleReminderDue);
    window.addEventListener('exerciseNudge', handleExerciseNudge);

    return () => {
      window.removeEventListener('medicationReminder', handleMedicationReminder);
      window.removeEventListener('reminderDue', handleReminderDue);
      window.removeEventListener('exerciseNudge', handleExerciseNudge);
    };
  }, []);

  const clearReminder = () => {
    setReminder(null);
    setShowSkipConfirm(false);
    sessionStorage.removeItem('reminderData');
  };

  const clearNudge = () => {
    setNudge(null);
    setMoodPrompt(false);
  };

  const handleCloseReminder = () => {
    clearReminder();
  };

  const handleCloseNudge = () => {
    clearNudge();
  };

  const handleCloseMood = () => {
    clearNudge();
  };

  const handleMedicationConfirm = async (taken) => {
    if (!reminder || !reminder.medication?.id) {
      clearReminder();
      return;
    }

    try {
      const baseUrl = getBaseUrl();
      const response = await fetch(`${baseUrl}/api/med/confirm/${reminder.medication.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, taken }),
      });

      if (response.ok) {
        clearReminder();
      } else {
        console.error('Failed to confirm medication');
      }
    } catch (error) {
      console.error('Error confirming medication:', error);
    }
  };

  const handleCustomDone = async () => {
    if (!reminder?.reminderId) {
      clearReminder();
      return;
    }
    try {
      const baseUrl = getBaseUrl();
      const res = await fetch(`${baseUrl}/api/reminder/${username}/${reminder.reminderId}/ack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'done' }),
      });
      if (res.ok) clearReminder();
      else console.error('Could not update reminder');
    } catch (e) {
      console.error(e);
    }
  };

  const handleCustomSnooze = async () => {
    if (!reminder?.reminderId) {
      clearReminder();
      return;
    }
    try {
      const baseUrl = getBaseUrl();
      const res = await fetch(`${baseUrl}/api/reminder/${username}/${reminder.reminderId}/ack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'snoozed', snoozeMinutes: 10 }),
      });
      if (res.ok) clearReminder();
      else console.error('Could not snooze');
    } catch (e) {
      console.error(e);
    }
  };

  const handleSkipConfirm = () => {
    setShowSkipConfirm(false);
    clearReminder();
  };

  const handleMoodCheckIn = async (mood) => {
    try {
      const baseUrl = getBaseUrl();
      const response = await fetch(`${baseUrl}/api/med/mood/${username}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mood }),
      });

      if (response.ok) {
        clearNudge();
      } else {
        console.error('Failed to record mood');
      }
    } catch (error) {
      console.error('Error recording mood:', error);
    }
  };

  const isMedication = reminder && (reminder.category === 'medication' || reminder.medication);
  const isMovement = reminder?.category === 'movement' || reminder?.action === 'nudge';
  const isCustom = reminder && !isMedication && !isMovement;

  if (!reminder && !nudge && !moodPrompt) {
    return null;
  }

  return (
    <div className="overlay-backdrop">
      {reminder && isMedication && (
        <div className="reminder-card">
          <button
            type="button"
            className="reminder-overlay-close"
            onClick={handleCloseReminder}
            aria-label="Close"
          >
            ×
          </button>
          <div className="reminder-header">
            <span className="reminder-icon">💊</span>
            <h2>Medication Reminder</h2>
          </div>
          <div className="reminder-content">
            <p className="reminder-medication-name">{reminder.medication?.name || reminder.title || 'General reminder'}</p>
            {(reminder.medication?.dosage || reminder.medication?.form) && (
              <p className="reminder-dosage">{[reminder.medication.dosage, reminder.medication.form].filter(Boolean).join(' • ')}</p>
            )}
            <p className="reminder-instructions">{reminder.medication?.instructions || reminder.voicePrompt || ''}</p>
          </div>
          <div className="reminder-actions">
            <button className="reminder-button taken" onClick={() => handleMedicationConfirm(true)}>
              Taken
            </button>
            <button className="reminder-button later" onClick={() => handleMedicationConfirm(false)}>
              Remind me later
            </button>
            <button className="reminder-button skip" onClick={() => setShowSkipConfirm(true)}>
              Skip
            </button>
          </div>
          {showSkipConfirm && (
            <div className="reminder-skip-confirm">
              <p>Skipping can impact your medication routine. Are you sure?</p>
              <div className="reminder-skip-actions">
                <button type="button" className="reminder-button skip-yes" onClick={handleSkipConfirm}>
                  Yes, skip
                </button>
                <button type="button" className="reminder-button skip-cancel" onClick={() => setShowSkipConfirm(false)}>
                  Go back
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {reminder && isCustom && (
        <div className="reminder-card reminder-card-custom">
          <button
            type="button"
            className="reminder-overlay-close"
            onClick={handleCloseReminder}
            aria-label="Close"
          >
            ×
          </button>
          <div className="reminder-header">
            <span className="reminder-icon">🔔</span>
            <h2>Reminder</h2>
          </div>
          <div className="reminder-content">
            <p className="reminder-medication-name">{reminder.title || 'General reminder'}</p>
            <p className="reminder-instructions">{reminder.voicePrompt || reminder.cta || 'You have a scheduled reminder.'}</p>
          </div>
          <div className="reminder-actions">
            <button className="reminder-button taken" onClick={handleCustomDone}>
              Done
            </button>
            <button className="reminder-button later" onClick={handleCustomSnooze}>
              Snooze
            </button>
            <button className="reminder-button skip" onClick={handleCloseReminder}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {(reminder?.category === 'movement' || reminder?.action === 'nudge' || nudge) && !moodPrompt && (
        <div className="nudge-card">
          <button
            type="button"
            className="reminder-overlay-close"
            onClick={handleCloseNudge}
            aria-label="Close"
          >
            ×
          </button>
          <div className="nudge-header">
            <span className="nudge-icon">💡</span>
            <h2>Exercise Suggestion</h2>
          </div>
          <div className="nudge-content">
            <p className="nudge-suggestion">{(reminder || nudge)?.suggestion || reminder?.movementSuggestion || 'A light 10-15 min walk can help reach goal today.'}</p>
            <p className="nudge-details">{(reminder || nudge)?.details || ''}</p>
          </div>
          <div className="nudge-actions">
            <button className="nudge-button close" onClick={() => { if (reminder) clearReminder(); else clearNudge(); }}>
              Got it
            </button>
            <button className="nudge-button later" onClick={() => { if (reminder) clearReminder(); else clearNudge(); }}>
              Remind me later
            </button>
          </div>
        </div>
      )}

      {moodPrompt && (
        <div className="mood-card">
          <button
            type="button"
            className="reminder-overlay-close"
            onClick={handleCloseMood}
            aria-label="Close"
          >
            ×
          </button>
          <div className="mood-header">
            <span className="mood-icon">😊</span>
            <h2>How are you feeling?</h2>
          </div>
          <div className="mood-content">
            <p>Quick check-in (optional)</p>
          </div>
          <div className="mood-actions">
            <button className="mood-button good" onClick={() => handleMoodCheckIn('Good')}>
              Good
            </button>
            <button className="mood-button okay" onClick={() => handleMoodCheckIn('Okay')}>
              Okay
            </button>
            <button className="mood-button low" onClick={() => handleMoodCheckIn('Low')}>
              Low
            </button>
            <button className="mood-button skip" onClick={handleCloseMood}>
              Skip
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default ReminderNudgeOverlay;
