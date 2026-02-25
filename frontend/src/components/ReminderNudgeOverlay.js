import React, { useState, useEffect } from 'react';
import '../css/reminderNudgeOverlay.css';

const ReminderNudgeOverlay = () => {
  const [reminder, setReminder] = useState(null);
  const [nudge, setNudge] = useState(null);
  const [moodPrompt, setMoodPrompt] = useState(false);

  useEffect(() => {
    const handleReminder = (event) => {
      setReminder(event.detail);
    };

    const handleNudge = (event) => {
      setNudge(event.detail);
      if (event.detail.promptMood) {
        setMoodPrompt(true);
      }
    };

    window.addEventListener('medicationReminder', handleReminder);
    window.addEventListener('exerciseNudge', handleNudge);

    return () => {
      window.removeEventListener('medicationReminder', handleReminder);
      window.removeEventListener('exerciseNudge', handleNudge);
    };
  }, []);

  const handleMedicationConfirm = async (taken) => {
    if (!reminder) return;

    try {
      const isLocalDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
      const baseUrl = isLocalDev ? 'http://localhost:5001' : (process.env.REACT_APP_FETCH_DATA_URL || 'http://localhost:5001');
      
      const response = await fetch(`${baseUrl}/api/med/confirm/${reminder.medication.id}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username: 'amy', // TODO: get from context
          taken: taken,
        }),
      });

      if (response.ok) {
        setReminder(null);
      } else {
        console.error('Failed to confirm medication');
      }
    } catch (error) {
      console.error('Error confirming medication:', error);
    }
  };

  const handleMoodCheckIn = async (mood) => {
    try {
      const isLocalDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
      const baseUrl = isLocalDev ? 'http://localhost:5001' : (process.env.REACT_APP_FETCH_DATA_URL || 'http://localhost:5001');
      
      const response = await fetch(`${baseUrl}/api/med/mood/amy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          mood: mood,
        }),
      });

      if (response.ok) {
        setMoodPrompt(false);
        setNudge(null);
      } else {
        console.error('Failed to record mood');
      }
    } catch (error) {
      console.error('Error recording mood:', error);
    }
  };

  if (!reminder && !nudge && !moodPrompt) {
    return null;
  }

  return (
    <div className="overlay-backdrop">
      {reminder && (
        <div className="reminder-card">
          <div className="reminder-header">
            <span className="reminder-icon">💊</span>
            <h2>Medication Reminder</h2>
          </div>
          <div className="reminder-content">
            <p className="reminder-medication-name">{reminder.medication.name}</p>
            <p className="reminder-dosage">{reminder.medication.dosage} ({reminder.medication.form})</p>
            <p className="reminder-instructions">{reminder.medication.instructions}</p>
          </div>
          <div className="reminder-actions">
            <button 
              className="reminder-button taken"
              onClick={() => handleMedicationConfirm(true)}
            >
              Taken
            </button>
            <button 
              className="reminder-button later"
              onClick={() => handleMedicationConfirm(false)}
            >
              Remind me later
            </button>
          </div>
        </div>
      )}

      {nudge && !moodPrompt && (
        <div className="nudge-card">
          <div className="nudge-header">
            <span className="nudge-icon">💡</span>
            <h2>Exercise Suggestion</h2>
          </div>
          <div className="nudge-content">
            <p className="nudge-suggestion">{nudge.suggestion}</p>
            <p className="nudge-details">{nudge.details}</p>
          </div>
          <div className="nudge-actions">
            <button 
              className="nudge-button close"
              onClick={() => {
                setNudge(null);
                if (nudge.promptMood) {
                  setMoodPrompt(true);
                }
              }}
            >
              Got it
            </button>
          </div>
        </div>
      )}

      {moodPrompt && (
        <div className="mood-card">
          <div className="mood-header">
            <span className="mood-icon">😊</span>
            <h2>How are you feeling?</h2>
          </div>
          <div className="mood-content">
            <p>Quick check-in (optional)</p>
          </div>
          <div className="mood-actions">
            <button 
              className="mood-button good"
              onClick={() => handleMoodCheckIn('Good')}
            >
              Good
            </button>
            <button 
              className="mood-button okay"
              onClick={() => handleMoodCheckIn('Okay')}
            >
              Okay
            </button>
            <button 
              className="mood-button low"
              onClick={() => handleMoodCheckIn('Low')}
            >
              Low
            </button>
            <button 
              className="mood-button skip"
              onClick={() => {
                setMoodPrompt(false);
                setNudge(null);
              }}
            >
              Skip
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default ReminderNudgeOverlay;

