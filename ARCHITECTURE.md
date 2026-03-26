# Architecture

## Single Pipeline: Intent → Plan → Parallel Execute

The system uses a single LLM pipeline to answer Fitbit health questions over Alexa + smart screen. All charts are generated in parallel and auto-advanced — Alexa speaks a combined narrative while the frontend cycles through charts automatically.

```
Lambda (unchanged) → POST /api/alexa (raw JSON string body)
  ↓
alexaRouter.js (thin router: parse, dispatch, fire-and-forget + WebSocket push)
  ↓
qnaOrchestrator.js (3-step coordinator)
  Step 1: classifyIntent → planQuestion (LLM decides metrics + stages)
  Step 2: dataFetchService.fetchAndComputeEvidence (Fitbit data + statistical evidence)
  Step 3: executorAgent.generateAllStages (parallel Promise.all → all charts at once)
  ↓
Return { GPTresponse: voice_text } to Lambda
WebSocket emit → smart screen
```

### Pipeline Steps

```
Alexa utterance
    ↓
Intent Classifier (GPT)         configs/agentConfigs.js: INTENT_CLASSIFIER_SYSTEM_PROMPT
    ↓ enrichedIntent { inferred_metrics, time_range, display_label, ... }
Planner V2 (GPT)                services/qna/plannerAgent.js
    ↓ sub_analyses [ { id, label, metrics_needed, time_scope, analysis_type } ]
    ↓ stages_plan [ { stageIndex, sub_analysis_ids, visualization_intent, chartType, title, goal } ]
Multi-Window Fetch + Evidence   services/qna/dataFetchService.js → fetchAndComputeEvidence()
    ↓ multiWindowData { [saId]: { normalizedTable, window, metrics } }
    ↓ evidenceBundle { sub_analyses: { stats, anomalies }, cross_analysis: { deltas, correlations } }
Chart Strategy Service          services/charts/chartStrategyService.js → generateViableStrategies()
    ↓ viableStrategies [ { strategy_id, chart_type, description, data_sources, metrics } ]
Executor V3 (GPT × N parallel)  services/qna/executorAgent.js → generateAllStages()
    ↓ GPT picks selected_strategy_id + writes narration text
    ↓ services/charts/chartStrategyService.js → buildChartFromStrategy() builds chart_data
    ↓ stages [ { spoken_text, screen_text, chart_spec } ]
Response to Alexa               routers/alexaRouter.js
```

---

## Key Files

| File | Role |
|---|---|
| `backend/routers/alexaRouter.js` | Thin router — parse Lambda/browser requests, dispatch to orchestrator, fire-and-forget pipeline with immediate WebSocket push, Lambda polls for voice answer |
| `backend/services/qna/qnaOrchestrator.js` | 3-step pipeline coordinator; single `activeJobs` Map for in-memory state; exports `handleQuestion`, `handleNavigation`, `resumePending` |
| `backend/services/qna/dataFetchService.js` | All Fitbit data fetching + evidence computation; exports `fetchAndComputeEvidence()` |
| `backend/services/qna/responseBuilder.js` | Response formatting; exports `buildStageResult`, `buildPendingResponse`, `buildTerminalResponse`, `buildLambdaResponse` |
| `backend/services/qna/plannerAgent.js` | Runs planner LLM (V2 query decomposition); always returns `sub_analyses[]` + `stages_plan[]` |
| `backend/services/qna/executorAgent.js` | Generates all N stages in parallel via evidence+strategy selection |
| `backend/services/qna/stageService.js` | Stage normalization, payload building, chart spec hydration |
| `backend/configs/agentConfigs.js` | All LLM prompts, JSON schemas, and shared constants |
| `backend/services/openai/executorClient.js` | Builds executor user message; calls OpenAI |
| `backend/services/openai/plannerClient.js` | Builds planner request (V2 with query decomposition); calls OpenAI |
| `backend/services/analytics/evidenceComputer.js` | Pure deterministic math: stats, correlations, deltas, anomalies, trends |
| `backend/services/charts/chartStrategyService.js` | Generates viable chart strategies from data + evidence; builds chart_data deterministically |
| `backend/services/charts/metricExtractor.js` | Shared: extractDailySeries, extractMultiMetricSeries, computeAverage, deriveUnit |
| `backend/services/qna/bundleService.js` | Creates/updates QnaBundle documents in MongoDB |
| `backend/services/qna/intentClassifierService.js` | Classifies utterances; extracts display_label, inferred_metrics |
| `backend/services/qna/auditService.js` | Audit logging |
| `backend/services/fitbit/endpointAdapters.js` | Maps raw Fitbit API responses to normalized rows |
| `backend/services/fitbit/metricResolver.js` | Maps user language to canonical metric keys |
| `backend/models/QnaBundle.js` | Mongoose schema for QnaBundle |
| `backend/lambda/index.js` | Alexa Lambda — axios shim handles format translation (DO NOT modify logic) |

---

## State Management

### Single `activeJobs` Map (in-memory, per-user)

Replaces the previous 5 scattered state locations (qnaJobs, resumableJobsByUser, latestQuestionJobByUser, RUNTIME_STAGE_REQUESTS, sessionService).

```javascript
activeJobs.get("amy") = {
  bundleId: "...",         // MongoDB bundle ID
  promise: Promise,        // the pipeline promise (for resumePending)
  stages: [],              // all generated stages (populated when complete)
  stagesPlan: [],          // planner output
  currentChartIndex: 0,    // which chart user is viewing
  complete: false,         // true when all stages generated
  startedAt: Date.now(),
}
```

### MongoDB (persistent)

QnaBundle stores: question, plannerOutput, stages[], currentStageIndex, status, displayLabel.

### Router has NO state

The router is a pure request→response translator. All state lives in the orchestrator's `activeJobs` Map or MongoDB.

---

## Request Flow (Await + Immediate WebSocket Push)

**Problem solved:** Screen only updated when Lambda polled, not when the pipeline actually finished.

**Solution: Await pipeline with 5s timeout + `.then()` for immediate WebSocket push.**

New question from Lambda (`tryAgain=false`):
```javascript
const pipelinePromise = orchestrator.handleQuestion({ username, question, requestSource: "alexa" });

// Push to screen the instant pipeline finishes, even if Lambda already timed out
pipelinePromise.then((result) => {
  if (result?.answer_ready && result?.payload) {
    emitResultToFrontend(username, result);
    emitStatus(username, "completed", "Your health analysis is ready.");
  }
});

// Wait up to 5s for pipeline
const result = await Promise.race([pipelinePromise, 5000ms timeout]);
if (result?.answer_ready) return lambdaReply(result.voice_answer);
return lambdaReply("Still working on that");
```

Lambda polls with `tryAgain=true`:
```javascript
const result = await orchestrator.resumePending(username);
if (result?.answer_ready) return lambdaReply(result.voice_answer);
return lambdaReply("Still working on that");
```

**Key benefit:** The screen updates via WebSocket as soon as the pipeline finishes, independent of Lambda's polling. If the pipeline completes within 5s, Lambda gets the voice answer directly. If not, Lambda polls via `resumePending`.

One state store (`activeJobs`), one resume check (`resumePending`). No parallel Maps that can get out of sync.

---

## Auto-Advance (Speech-Synchronized)

All charts are generated upfront in parallel. Instead of requiring "next"/"back" commands:

- **Voice (Alexa):** `buildCombinedVoiceAnswer()` in `stageService.js` combines all stages into one flowing narrative: "First up: [stage 0]. Moving on: [stage 1]. And finally: [stage 2]."
- **Screen (frontend):** `QnAPage.js` uses **speech-event-driven advancing** when `payload.autoAdvance === true`. Each chart's narration is spoken individually via `SpeechSynthesisUtterance`, and `onend` triggers the next chart — keeping charts perfectly synchronized with their narration. Falls back to a 10-second timer per stage if browser TTS is unavailable.
- **Intent classification:** ALL utterances go through the GPT intent classifier (`classifyIntent`) — no hardcoded phrase matching. The classifier handles "next", "back", "next conversing", or any natural phrasing.
- **`clearRuntimeState`** is called only after `classifyIntent` confirms the utterance is a new question (not navigation), preventing in-memory job wipe for navigation commands.

---

## Cross-Metric Inference

The planner decomposes broad health topics into cross-domain sub-analyses:

- **"heart health"** → heart metrics (resting_hr, hrv) + sleep (sleep_minutes, sleep_deep) + activity (steps)
- **"sleep quality"** → sleep metrics + heart metrics + activity
- **"overall health"** → all major domains

At least one stage in a 3-4 stage plan explores a **relationship** between health domains (e.g. "Does activity help your sleep?").

The executor uses evidence bundle correlations (pearson_r, interpretation) to narrate cross-domain insights:
- "On days you were more active, your sleep tended to be deeper and more restorative."
- "Your resting heart rate was noticeably lower after nights with 7+ hours of sleep."

---

## Evidence Computer (`backend/services/analytics/evidenceComputer.js`)

Pure deterministic functions — no I/O, no LLM calls.

| Function | Returns |
|---|---|
| `computeMetricStats(rows, metricKey)` | `{ mean, median, min, max, stddev, latest, trend_direction, trend_slope, unit }` |
| `detectAnomalies(rows, metricKey, threshold)` | `[{ date, value, zscore, direction }]` |
| `computeCorrelation(rows, metricA, metricB)` | `{ pearson_r, interpretation, description, sample_size }` |
| `computeDelta(valueA, valueB, metricKey)` | `{ delta, delta_pct, direction, significance }` |
| `computeDayOfWeekPattern(rows, metricKey)` | `{ Mon: avg, Tue: avg, ... }` |
| `buildEvidenceBundle(multiWindowData)` | Full evidence bundle with per-sub-analysis stats + cross-analysis comparisons |

These replace sending raw rows to GPT. The evidence bundle is ~30 lines of pre-computed facts vs 180 lines of raw numbers.

---

## Chart Strategy Service (`backend/services/charts/chartStrategyService.js`)

**`generateViableStrategies({ stageSpec, multiWindowData, evidenceBundle, previousChartTypes })`**
- Generates 3-6 viable chart strategy descriptions per stage
- Cross-period strategies: `grouped_bar_cross_period`, `bar_with_reference`
- Single-analysis strategies: `line_trend`, `multi_line_comparison`, `bar_daily`, `area_trend`, `stacked_bar_sleep_stages`, `scatter_relationship`, `gauge_latest`, `radar_overview`, `list_summary_overview`, `composed_summary`
- Penalizes already-used chart types

**`buildChartFromStrategy(strategyId, multiWindowData, evidenceBundle, viableStrategies)`**
- After GPT picks a `selected_strategy_id`, deterministically builds `chart_data`
- No hallucinated numbers — all chart data is backend-owned

---

## Data Fetch Service (`backend/services/qna/dataFetchService.js`)

Extracted from orchestrator — all Fitbit fetching logic:

- `computeDateWindow(timeScope)` → `{ startDate, endDate }`
- `fetchMultiWindowData({ bundle, username, subAnalyses })` → deduplicates metric+window combos
- `fetchAndComputeEvidence({ bundle, username, subAnalyses })` → combines fetch + `buildEvidenceBundle()` + persists merged table

### TIME_SCOPE_DAY_CONFIG

```javascript
{
  today:                { days: 1, offset: 0 },
  yesterday:            { days: 1, offset: 1 },
  last_night:           { days: 1, offset: 1 },
  day_before_yesterday: { days: 1, offset: 2 },
  this_week:            { days: 7, offset: 0 },
  last_week:            { days: 7, offset: 7 },
  last_3_days:          { days: 3, offset: 0 },
  last_7_days:          { days: 7, offset: 0 },
  last_14_days:         { days: 14, offset: 0 },
  last_30_days:         { days: 30, offset: 0 },
}
```

---

## Planner Schema (PLANNER_TEXT_FORMAT_V2)

```json
{
  "analysis_goal": "string",
  "sub_analyses": [
    {
      "id": "sa_0",
      "label": "Yesterday's sleep",
      "metrics_needed": ["sleep_minutes", "sleep_deep"],
      "time_scope": "yesterday",
      "analysis_type": "snapshot"
    }
  ],
  "stages_plan": [
    {
      "stageIndex": 0,
      "sub_analysis_ids": ["sa_0", "sa_1"],
      "visualization_intent": "side-by-side comparison of two nights",
      "chartType": "grouped_bar",
      "title": "",
      "goal": ""
    }
  ]
}
```

---

## Executor Schema (EXECUTOR_TEXT_FORMAT_V3)

| Field | Source | Purpose |
|---|---|---|
| `evidence` | evidenceComputer.js | Pre-computed stats, anomalies, correlations, deltas |
| `viable_strategies` | chartStrategyService.js | 3-6 strategy options GPT picks from |
| `stage_specification` | plannerOutput.stagesPlan[i] | visualization_intent, focusMetrics, chartType hint |
| `selected_strategy_id` | GPT output | Which strategy to build chart_data from |

GPT uses evidence for narration (no arithmetic needed), picks a strategy, and the backend builds chart_data deterministically.

---

## Lambda ↔ Backend Compat Layer

The Lambda sends raw JSON-string bodies (`JSON.stringify(question)`) with `Content-Type: application/json`.

### Backend-side responsibilities (alexaRouter.js `handleLambdaRequest`)

1. **Body parsing** — `req.body` is a JS string after `express.json({ strict: false })`. Strips `start ` prefix and `user query:` context wrapper.
2. **Poll detection** — `req.query.tryAgain === "true"` → `orchestrator.resumePending(username)`.
3. **Intent classification** — all utterances go through GPT classifier; no hardcoded navigation matching.
4. **Await + WebSocket push** — new questions await the pipeline for up to 5s. A `.then()` handler pushes results to the frontend via WebSocket the instant the pipeline finishes, even if Lambda has already timed out. Lambda polls with `tryAgain=true` if the initial request doesn't return an answer.
5. **Response format** — replies with `{ GPTresponse, smallTalk }`.

---

## Design Principles

- **Alexa is not responsible for state management.** All state lives in the backend (activeJobs Map + MongoDB).
- **Chart data is deterministic and backend-owned.** GPT picks a strategy, but never generates chart numbers.
- **Evidence replaces raw rows.** GPT receives pre-computed stats (~30 lines) instead of 180 raw data rows.
- **All stages generated in parallel** via `Promise.all()` in `generateAllStages()`.
- **Voice first, screen second.** `spoken_text` is 2–3 complete sentences; `screen_text` is structured for readability.
- **One number per spoken response.** Number-selection rule in executor prompt.
- **Cross-metric inference.** Broad questions trigger cross-domain analysis with correlation-based narration.
- **Single pipeline.** No V2/V3 split. One flow for all questions.
- **No duplicate responses.** Single pipeline await, single state store, single resume check.
- **Immediate screen updates.** `.then()` WebSocket push happens the instant the pipeline finishes, even if Lambda has already timed out.
