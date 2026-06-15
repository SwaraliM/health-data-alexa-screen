# Health Data Alexa Screen — System Documentation

This document describes how to run the system, its architecture, and everything it is capable of.

---

## 1. Getting Started

### Prerequisites
- Node.js + npm
- A MongoDB Atlas connection string
- An OpenAI API key
- Fitbit OAuth app credentials (client ID + secret)

### Environment Variables (`backend/.env`)

| Variable | Purpose |
|---|---|
| `MONGODB_URL` | MongoDB Atlas connection string (required) |
| `OPENAI_API_KEY` | OpenAI API key for GPT models (required) |
| `FITBIT_CLIENT_ID` | Fitbit OAuth client ID (required) |
| `FITBIT_CLIENT_SECRET` | Fitbit OAuth client secret (required) |
| `API_URL` | Base API URL for external callbacks |
| `USE_LLM_OPTION_GENERATION` | Enable LLM-driven chart option generation (`true`/`false`) |
| `OPENAI_EXECUTOR_V4_MODEL` | Model used for chart/stage generation (default: `gpt-4.1`) |
| `OPENAI_EXECUTOR_V4_TIMEOUT_MS` | Generation timeout in ms (`0` = no timeout, recommended) |
| `QNA_ROUTER_DEBUG` | Verbose logging for the Alexa router |
| `QNA_ORCHESTRATOR_DEBUG` | Verbose logging for the QnA orchestrator |
| `FITBIT_ROUTER_DEBUG` | Verbose logging for the Fitbit proxy router |
| `FITBIT_ADAPTER_DEBUG` | Verbose logging for Fitbit data adapters |
| `FITBIT_METRIC_RESOLVER_DEBUG` | Verbose logging for metric resolution |

### Running in Production

```bash
# From repo root
npm start
```
This runs `node server.js`, which starts the backend (Express + WebSocket) on **port 5001** and serves the pre-built frontend from `frontend/build`.

### Running in Development

```bash
# Terminal 1 — backend
cd backend
npm start          # node server.js, port 5001

# Terminal 2 — frontend (hot reload)
cd frontend
npm start          # dev server on port 3000
```

### Building the Frontend

```bash
cd frontend
npm run build
```

### Running Tests

```bash
# Backend
cd backend
npm test           # runs tests in /tests and /services/qna/__tests__

# Frontend
cd frontend
npm test           # React Scripts test runner
```

---

## 2. System Architecture

### Components

1. **Backend** (Node.js + Express + MongoDB)
   - Entry point: `backend/index.js` (registers routers)
   - Server: `backend/server.js` — HTTP + WebSocket server, port 5001
   - Database: MongoDB via Mongoose

2. **Frontend** (React + ECharts)
   - Served by the backend from `frontend/build`
   - Dev server runs separately on port 3000 with hot reload
   - Main pages: Today/Dashboard, QnA, Reminders, Activity detail, Auth callback

3. **WebSocket layer** (`backend/websocket.js`)
   - Real-time delivery of charts, reminders, and notifications to the smart screen/browser

4. **Alexa Integration**
   - `backend/lambda/index.js` — AWS Lambda skill handler (do not modify; all state lives in the backend)
   - `backend/routers/alexaRouter.js` — backend gateway that the Lambda calls into

### Q&A Pipeline (Intent → Plan → Bundle Author)

```
Alexa / web utterance
    ↓
Intent Classifier (LLM)            → enrichedIntent { inferred_metrics, time_range, display_label }
    ↓
Planner V2 (LLM)                   → sub_analyses[], stages_plan[]
    ↓
Multi-Window Fetch + Evidence      → multiWindowData, evidenceBundle
    ↓
Chart Strategy Service             → bundleCandidates [ viable_strategies[] ]
    ↓
Executor (single bundle-authoring LLM request) → stages[ { spoken_text, screen_text, chart_spec } ]
    ↓
Response (voice + chart) to Alexa / screen
```

**Key modules:**
- `qnaOrchestrator.js` — coordinates the pipeline, holds in-memory `activeJobs` state
- `alexaTurnResolver.js` — classifies incoming Alexa utterances (new question, resume, navigation, chart follow-up, etc.)
- `chartQnaClassifier.js` — LLM classifier for follow-up questions about a currently displayed chart
- `plannerAgent.js` — decomposes a question into sub-analyses and stage guidance
- `executorAgent.js` — authors the final stage bundle from evidence + chart strategies
- `chartQnaAgent.js` — answers follow-up questions about the visible chart without a full re-analysis
- `dataFetchService.js` — fetches Fitbit data and computes evidence windows
- `evidenceComputer.js` — deterministic statistics (averages, trends, correlations, anomalies)
- `chartStrategyService.js` — deterministically generates viable chart strategies
- `stageService.js` — normalizes authored stages into delivery payloads
- `bundleService.js` — MongoDB `QnaBundle` CRUD and state persistence
- `intentClassifierService.js` — classifies user intent and extracts target metrics

**State management:**
- In-memory (per session): `activeJobs` Map in the orchestrator — bundle ID, stages, current chart index, interaction state
- Persistent: MongoDB `QnaBundle` documents — stages, planner output, evidence, status

---

## 3. Capabilities

### Health Q&A
- Single-metric questions ("How did I sleep last night?")
- Comparisons ("How was my sleep today vs yesterday?")
- Relationship/correlation questions ("Does exercise help my sleep?")
- Summary/report questions ("Give me a health report")
- Anomaly detection ("Is anything unusual this week?")
- Evaluative questions with a direct verdict ("Has my sleep gotten worse?")

### Chart Generation
- Multi-stage answer bundles (1–4 charts per question)
- Chart types: `bar`, `grouped_bar`, `line`, `multi_line`, `stacked_bar`, `scatter`, `area`, `heatmap`, `radar`, `boxplot`, `gauge`, `pie`, `composed_summary`, `donut`, `timeline`, `treemap`, `candlestick`
- Multi-panel layouts (single, 2-up, 2-up + footer, 4-panel grid)
- Voice-driven chart navigation ("next chart", "go back", "start over")
- Voice-only follow-up Q&A about the currently displayed chart (no new analysis triggered)

### Alexa Voice Experience
- Automatic turn resolution (new question vs. navigation vs. chart follow-up vs. resume)
- Stage-by-stage narration with continuation prompts
- Chart delivery synchronized with spoken narration
- ~6.5s generation gate with contextual filler messages while content is generated
- "Ready to resume" notification if generation completes after the gate times out

### Medication Management
- Medication schedule creation
- Medication reminder popups + adherence tracking (taken / snoozed / missed)
- Manual mood check-ins (Good / Okay / Low)

### Reminders & Nudges
- Custom reminders: one-time, daily, weekly, monthly, or interval-based
- Categories: medication, activity, task, hydration, sleep, custom
- Delivery via popup and/or Alexa voice
- Snooze, acknowledge, mark-taken, and complete actions
- Exercise nudges with optional mood check-in

### Dashboard
- Up to 3 primary health metric tiles
- "Today's Insight" card
- Real-time updates via WebSocket

---

## 4. Supported Fitbit Data

### Daily Metrics
`steps`, `calories`, `distance`, `floors`, `elevation`, `sleep_minutes`, `sleep_deep`, `sleep_light`, `sleep_rem`, `sleep_awake`, `sleep_efficiency`, `resting_hr`, `hrv`, `breathing_rate`, `spo2`

### Intraday Metrics (hourly)
`steps_intraday`, `calories_intraday`, `distance_intraday`, `floors_intraday`, `heart_intraday`

### Time Scopes
`today`, `yesterday`, `last_night`, `day_before_yesterday`, `this_week`, `last_week`, `last_3_days`, `last_7_days`, `last_14_days`, `last_30_days`

### Domain Bundles (used for broad questions)
- **sleep** → sleep_minutes, sleep_efficiency, sleep_deep, sleep_rem, sleep_awake, resting_hr
- **activity** → steps, calories, distance, floors, resting_hr
- **heart health** → resting_hr, hrv, sleep_minutes, steps
- **overall health** → steps, calories, sleep_minutes, sleep_efficiency, sleep_deep, resting_hr, hrv

---

## 5. API Endpoints

### Alexa
- `POST /api/alexa/` — Lambda-compatible health question handler

### Web Q&A
- `POST /api/ai/qna-ask` — Q&A endpoint for testing/web (returns planner output + chart_spec payload)

### Fitbit Proxy
- `GET /api/fitbit/:username/activities/summary/:date`
- `GET /api/fitbit/:username/activities/goals/:period` (daily, weekly)
- `GET /api/fitbit/:username/activities/favorite|frequent|life-time|recent`
- `GET /api/fitbit/:username/activities/period/:resource/date/:date/:period`
- `GET /api/fitbit/:username/activities/range/:resource/date/:startDate/:endDate`
- `GET /api/fitbit/:username/activities/intraday/:resource/:date`
- `GET /api/fitbit/:username/body/log/:goalType/goal`
- `GET /api/fitbit/:username/body/log/:resource/date/:date`
- `GET /api/fitbit/:username/body/log/:resource/date/:startDate/:endDate`
- `GET /api/fitbit/:username/body/time-series/:resource/date/:startDate/:endDate`
- `GET /api/fitbit/:username/heart/period/date/:date/:period`
- `GET /api/fitbit/:username/heart/range/date/:startDate/:endDate`
- `GET /api/fitbit/:username/heart/intraday/:date`
- `GET /api/fitbit/:username/hrv/single-day/date/:date`
- `GET /api/fitbit/:username/hrv/range/date/:startDate/:endDate`
- `GET /api/fitbit/:username/br/single-day/date/:date` (breathing rate)
- `GET /api/fitbit/:username/br/range/date/:startDate/:endDate`
- `GET /api/fitbit/:username/spo2/single-day/date/:date`
- `GET /api/fitbit/:username/spo2/range/date/:startDate/:endDate`
- `GET /api/fitbit/:username/sleep/goal`
- `GET /api/fitbit/:username/sleep/single-day/date/:date`
- `GET /api/fitbit/:username/sleep/range/date/:startDate/:endDate`
- `GET /api/fitbit/:username/profile`
- `GET /api/fitbit/:username/devices`
- `GET /api/fitbit/:username/raw/*` (raw pass-through)

### Authentication
- `POST /api/login/` — username/password login
- `POST /api/login/save-token` — save Fitbit OAuth tokens
- `GET /api/login/authorized-users` — list authorized users

### Medications
- `GET /api/med/all/:username`
- `POST /api/med/:username/schedule/:medicationId`
- `GET /api/med/:username/schedule`
- `POST /api/med/reminder/:username` (demo trigger: medication reminder popup)
- `POST /api/med/confirm/:medicationId`
- `POST /api/med/nudge/:username` (demo trigger: exercise nudge)
- `POST /api/med/mood/:username`

### Reminders
- `POST /api/reminder/:username`
- `POST /api/reminder/:username/open-create`
- `GET /api/reminder/:username`
- `PATCH /api/reminder/:username/:reminderId`
- `DELETE /api/reminder/:username/:reminderId`
- `POST /api/reminder/:username/:reminderId/ack`
- `POST /api/reminder/:username/:reminderId/markTaken`
- `POST /api/reminder/:username/:reminderId/complete`
- `POST /api/reminder/:username/:reminderId/snooze`

---

## 6. Database Models (MongoDB)

### User
- `username`, `password`, `isAuthorized`
- `accessToken`, `refreshToken`, `tokenExpiry` (Fitbit OAuth)
- `userProfile`: `age`, `gender`, `fitnessLevel`, `healthGoals`, `healthConditions`
- `userProfile.preferences`: `preferredExercise[]`, `sleepGoalMinutes`, `dailyStepGoal`, `dailyCalorieGoal`
- `userProfile.moodCheckIns[]`: `{ date, mood, timestamp }`

### QnaBundle
- `bundleId`, `username`, `status` (active, partial, ready, completed, archived, released, failed)
- `question`, `displayLabel`
- `plannerOutput`, `stagesPlan[]`, `metricsRequested[]`
- `rawFitbitCache`, `normalizedTable`
- `stages[]` (final authored stages with `chart_spec`)
- `currentStageIndex`, `createdAt`, `updatedAt`

### Reminder
- `username`, `title`, `category`, `source`, `status`
- `schedule.timezone`, `schedule.rules[]`
- `payload`: `suggestion`, `targetMetric`, `medicationId`, `voicePromptTemplate`
- `delivery.popup`, `delivery.alexaVoice`
- `nextTriggerAt`, `adherence[]` (`{ dueAt, action, actedAt }`)

### Medication
- `username`, `name`, `dosage`, `form`, `instructions`
- `confirmations[]` (`{ date, taken, timestamp }`)

### NudgeEvent
- Tracks exercise nudges and mood check-ins

---

## 7. Frontend

### Pages
- Today/Dashboard — primary metric tiles + "Today's Insight"
- QnA — chart viewer with narration and navigation
- Reminders — create/manage reminders
- Activity (single day) — detailed activity view
- Auth callback — Fitbit OAuth flow

### Key Components
- `EChartCard` — ECharts-powered chart renderer
- Status notifications (completed, ready_to_resume, slow, error)
- Multi-panel layouts (1 panel, 2-up, 2-up + footer, 4-panel grid)

---

## 8. Configuration Reference (`backend/configs/agentConfigs.js`)

- `PLANNER_ALLOWED_MODES`: `new_analysis`, `continue_analysis`, `branch_analysis`
- `PLANNER_ALLOWED_TIME_SCOPES`: the 12 time ranges listed in Section 4
- `PLANNER_ALLOWED_STAGE_TYPES`: 14 stage types (overview, trend, relationship, sleep_stages, etc.)
- `EXECUTOR_ALLOWED_CHART_TYPES`: the 14 chart types listed in Section 3
- All LLM system prompts and JSON schemas for the planner/executor agents live here

---

## 9. Design Principles & Constraints

- **Evidence-based reasoning**: LLMs reason over pre-computed deterministic facts, not raw data rows.
- **Deterministic chart data**: the LLM selects a chart strategy; the backend computes the actual numbers.
- **One authored bundle per question**: a single executor call produces all stages for a question.
- **Voice first, screen second**: each stage delivers narration and its chart atomically.
- **Backend owns all state**: Alexa (`backend/lambda/index.js`) holds no state — session/job state lives in the orchestrator's `activeJobs` map and MongoDB. Do not modify `lambda/index.js` logic.
- **Broad questions expand to domain bundles** (e.g., "overall health" → steps, calories, sleep, resting HR, HRV).
