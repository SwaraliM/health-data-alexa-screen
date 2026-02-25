# Quick Start Guide

## Running the Demo

### 1. Start Backend
```bash
cd HealthData
node server.js
```
Backend runs on port 5001.

### 2. Start Frontend (Development)
```bash
cd HealthData/frontend
npm start
```
Frontend runs on port 3000 (default).

### 3. Access Dashboard
Navigate to: `http://localhost:3000/today-activity/amy/[random]`

## Manual Demo Triggers

### Medication Reminder (Flow C)
```bash
curl -X POST http://localhost:5001/api/med/reminder/amy
```
- Shows medication reminder overlay
- User can click "Taken" or "Remind me later"

### Exercise Nudge (Flow D)
```bash
curl -X POST http://localhost:5001/api/med/nudge/amy
```
- Shows exercise suggestion overlay
- Optionally prompts mood check-in

### Confirm Medication Taken
```bash
# First, get medication ID
curl http://localhost:5001/api/med/all/amy

# Then confirm (replace MEDICATION_ID)
curl -X POST http://localhost:5001/api/med/confirm/MEDICATION_ID \
  -H "Content-Type: application/json" \
  -d '{"username": "amy", "taken": true}'
```

### Record Mood Check-in
```bash
curl -X POST http://localhost:5001/api/med/mood/amy \
  -H "Content-Type: application/json" \
  -d '{"mood": "Good"}'
```
Valid moods: `"Good"`, `"Okay"`, `"Low"`

## Testing Q&A Flow (Flow B)

### Via Alexa (if configured)
- Ask: "How did I sleep?"
- Ask: "Am I on track for exercise today?"
- Ask: "Tell me more" (after previous question)

### Via API (if Alexa not available)
```bash
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

## Key Features to Verify

1. **Dashboard (Flow A)**
   - Shows ≤3 primary metric tiles
   - Stable layout
   - "Today's Insight" card

2. **Q&A (Flow B)**
   - 1-2 sentence summaries
   - Dashboard tile highlights when answering
   - "Tell me more" expands same topic

3. **Reminders (Flow C)**
   - Medication reminder overlay
   - Confirmation buttons work
   - Data persisted

4. **Nudges (Flow D)**
   - Exercise suggestion overlay
   - Mood check-in (once daily)
   - Data persisted

## Troubleshooting

- **WebSocket not connecting**: Check backend is running and user "amy" exists
- **Dashboard not loading**: Verify Fitbit data endpoint is accessible
- **Reminder/Nudge not appearing**: Check WebSocket connection in browser console
- **Anchor highlighting not working**: Verify `anchorKey` in WebSocket message

For detailed test procedures, see `WORKSHOP_SMOKE_TESTS.md`.

