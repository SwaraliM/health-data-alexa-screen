# Workshop Acceptance Test Flows

This document describes how to manually test the four workshop acceptance flows (A-D) for the MCI-oriented health companion prototype.

## Prerequisites

1. Backend server running on port 5001
2. Frontend running (typically on port 3000)
3. WebSocket connection established (automatic on page load)
4. User "amy" logged in and connected
5. Fitbit data available for the current date

## Flow A: Intro + Exploration

**Goal**: User can view dashboard without guidance.

**Steps**:
1. Navigate to `/today-activity/amy/[random]` (or let the app navigate automatically)
2. Verify dashboard displays:
   - Header with date, time, "Today Overview", and username
   - "Today's Insight" card (if data available)
   - Maximum 3 primary metric tiles (Steps, Calories, Distance)
   - Layout is stable and consistent

**Expected Outcome**:
- Dashboard loads without errors
- Layout is predictable and low cognitive load
- No more than 3 primary tiles visible
- Single-concept content blocks

**Verification**:
```bash
# Check dashboard loads
curl http://localhost:5001/api/fitbit/amy/activities/summary/$(date +%Y-%m-%d)
```

## Flow B: Template Qs + Anchor + Tell me more

**Goal**: User can ask "How did I sleep?" and "Am I on track for exercise today?" and get:
- Short summary + on-screen anchor highlight
- "Tell me more" path for details

**Steps**:

### B1: Sleep Question
1. Ask Alexa: "How did I sleep?"
2. Verify:
   - Voice response is 1-2 sentences
   - Dashboard tile highlights (if sleep tile exists)
   - Q&A page shows sleep-related data
   - Anchor highlight animation visible for 3-5 seconds

**Manual Test** (if Alexa not available):
```bash
# Trigger Q&A via API
curl -X POST http://localhost:5001/api/alexa/ \
  -H "Content-Type: application/json" \
  -d '{
    "version": "1.0",
    "request": {
      "type": "IntentRequest",
      "intent": {
        "name": "HowIntent",
        "slots": {
          "question": { "value": "did I sleep" }
        }
      }
    }
  }'
```

### B2: Exercise Question
1. Ask Alexa: "Am I on track for exercise today?"
2. Verify:
   - Voice response is 1-2 sentences about steps/exercise
   - Steps tile highlights on dashboard
   - Q&A page shows exercise-related data

### B3: Tell me more
1. After asking a question, ask: "Tell me more"
2. Verify:
   - Expanded details shown for the same topic
   - No new topics introduced

**Expected Outcome**:
- Answers are topic-focused (single topic only)
- Dashboard tiles highlight when relevant
- Summary-first, details on demand
- No information overload

## Flow C: Medication Reminder Trigger + Confirmation

**Goal**: System displays reminder card + voice prompt, user can confirm taken.

**Steps**:
1. Trigger medication reminder (manual demo endpoint):
```bash
curl -X POST http://localhost:5001/api/med/reminder/amy
```

2. Verify:
   - Overlay appears with medication reminder card
   - Voice prompt text displayed
   - Two buttons: "Taken" and "Remind me later"

3. Click "Taken":
```bash
# Get medication ID first
curl http://localhost:5001/api/med/all/amy

# Then confirm (replace MEDICATION_ID)
curl -X POST http://localhost:5001/api/med/confirm/MEDICATION_ID \
  -H "Content-Type: application/json" \
  -d '{
    "username": "amy",
    "taken": true
  }'
```

4. Verify:
   - Overlay disappears
   - Confirmation saved in database

**Expected Outcome**:
- Reminder card appears with clear medication info
- Large, accessible buttons
- Confirmation persisted with timestamp
- Neutral, non-alarmist language

## Flow D: Exercise Nudge Trigger + Optional Mood Check-in

**Goal**: System shows actionable suggestion, optionally prompts mood check-in.

**Steps**:
1. Trigger exercise nudge (manual demo endpoint):
```bash
curl -X POST http://localhost:5001/api/med/nudge/amy
```

2. Verify:
   - Overlay appears with exercise suggestion card
   - Single actionable suggestion displayed
   - "Got it" button available

3. Click "Got it":
   - Mood check-in prompt appears (once daily)

4. Select mood (Good/Okay/Low) or Skip:
```bash
# Record mood
curl -X POST http://localhost:5001/api/med/mood/amy \
  -H "Content-Type: application/json" \
  -d '{
    "mood": "Good"
  }'
```

5. Verify:
   - Mood saved with timestamp
   - Only one mood check-in per day allowed

**Expected Outcome**:
- Single actionable suggestion (not multiple)
- Mood check-in is optional and once daily
- Large tap targets for accessibility
- Emotionally safe, neutral language

## Verification Checklist

- [ ] Dashboard shows ≤3 primary tiles
- [ ] Dashboard layout is stable across sessions
- [ ] Q&A answers are 1-2 sentences by default
- [ ] Anchor highlighting works (3-5 second pulse)
- [ ] "Tell me more" expands same topic only
- [ ] Medication reminder shows confirmation flow
- [ ] Exercise nudge shows single suggestion
- [ ] Mood check-in is optional and once daily
- [ ] All buttons have large tap targets (≥48px)
- [ ] High contrast text and clear spacing

## Troubleshooting

**Dashboard not loading**:
- Check backend server is running: `curl http://localhost:5001/api/fitbit/amy/activities/summary/$(date +%Y-%m-%d)`
- Check WebSocket connection in browser console

**Anchor highlighting not working**:
- Check WebSocket messages in browser console
- Verify `anchorKey` is included in WebSocket payload
- Check `TodayActivityPage.js` has event listener for `anchorHighlight`

**Reminder/Nudge not appearing**:
- Verify WebSocket connection is active
- Check backend logs for reminder/nudge trigger
- Verify user "amy" exists in database

**Mood check-in not saving**:
- Check database for `moodCheckIns` array in user profile
- Verify date format is YYYY-MM-DD
- Check only one mood per day is allowed

