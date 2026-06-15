# Architecture

## Single Pipeline: Intent → Plan → Bundle Author

The system uses a single LLM pipeline to answer Fitbit health questions over Alexa + smart screen. The backend authors one coherent multi-chart answer bundle, stores it, and then delivers one chart+narration pair at a time. The backend owns conversation state, resolves each Alexa utterance against the active interaction, and keeps screen/speech synchronized.

```
Lambda (unchanged) → POST /api/alexa (raw JSON string body)
  ↓
alexaRouter.js (thin router: parse, dispatch, fire-and-forget + WebSocket push)
  ↓
qnaOrchestrator.js (3-step coordinator)
  Step 1: classifyIntent → planQuestion (LLM decides metrics + stages)
  Step 2: dataFetchService.fetchAndComputeEvidence (Fitbit data + statistical evidence)
  Step 3: executorAgent.generateAllStages (single bundle-authoring request → ordered authored stages)
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
    ↓ stages_plan [ { stageIndex, sub_analysis_ids, visualization_intent, chartType, title, goal, display_group } ]
Multi-Window Fetch + Evidence   services/qna/dataFetchService.js → fetchAndComputeEvidence()
    ↓ multiWindowData { [saId]: { normalizedTable, window, metrics } }
    ↓ evidenceBundle { sub_analyses: { stats, anomalies }, cross_analysis: { deltas, correlations } }
Chart Strategy Service          services/charts/chartStrategyService.js → generateViableStrategies()
    ↓ bundleCandidates [ { stage_index, goal, viable_strategies[] } ]
Executor V3 (single GPT bundle pass)  services/qna/executorAgent.js → generateAllStages()
    ↓ GPT authors one coherent bundle and picks one strategy per stage
    ↓ services/charts/chartStrategyService.js → buildChartFromStrategy() builds chart_data
    ↓ stages [ { spoken_text, screen_text, chart_spec, metadata.bundleThread } ]
Response to Alexa               routers/alexaRouter.js
```

---

## Key Files

| File | Role |
|---|---|
| `backend/routers/alexaRouter.js` | Lambda/browser compat router — resolves Alexa turns, starts/resumes/navigation-dispatches, and performs atomic chart+narration delivery |
| `backend/services/qna/qnaOrchestrator.js` | 3-step pipeline coordinator plus per-user interaction state; exports `handleQuestion`, `handleNavigation`, `answerChartQuestion`, `resumePending`, `getInteractionState`, `getActiveRuntime`, `markStageDelivered` |
| `backend/services/qna/alexaTurnResolver.js` | Alexa-only turn classification (async): `new_health_question`, `resume_pending`, `navigation`, `small_talk_ack`, `ignore_chatter`, `cancel_reset`, `no_active_context_fallback`, `chart_qna`. When a chart is visible and the utterance looks like a question, calls the chart QnA classifier LLM before routing. Health signals include common verb forms (e.g. **slept**, **walking**) so phrases like “how I slept this week” are not misclassified as `ignore_chatter`. |
| `backend/services/qna/chartQnaClassifier.js` | LLM classifier (GPT-4o-mini) that decides whether a follow-up utterance is about the current chart (`chart_qna`) or a new health question. Falls back to `new_health_question` on any failure. |
| `backend/services/qna/chartQnaAgent.js` | Lightweight LLM agent that answers chart follow-up questions using the stage's chart_data plus the bundle's stored evidence. No Fitbit fetch, no chart generation, no stage mutation. |
| `backend/services/qna/dataFetchService.js` | All Fitbit data fetching + evidence computation; exports `fetchAndComputeEvidence()` |
| `backend/services/qna/responseBuilder.js` | Response formatting; exports `buildStageResult`, `buildPendingResponse`, `buildTerminalResponse`, `buildChartQnaResult`, `buildLambdaResponse` |
| `backend/services/qna/plannerAgent.js` | Runs planner LLM (V2 query decomposition); returns `sub_analyses[]` + soft `stages_plan[]` guidance, then applies `ensureDisplayGroup` (integer normalization only — no grouping override). All chart layout decisions are made by the LLM via prompt examples. |
| `backend/services/qna/executorAgent.js` | Generates one authored multi-chart bundle from evidence+strategy candidates, then normalizes it into ordered backend-owned stages |
| `backend/services/qna/stageService.js` | Stage normalization, payload building, chart spec hydration, speech timing estimation, `chartAdvanceSchedule` generation. Each `chartAdvanceSchedule` entry now includes `narration_text` (the stage's `spokenText`) for frontend voice/screen sync. |
| `backend/configs/agentConfigs.js` | All LLM prompts, JSON schemas, and shared constants |
| `backend/services/openai/executorClient.js` | Builds authored-bundle executor request; calls OpenAI |
| `backend/services/openai/plannerClient.js` | Builds planner request (V2 with query decomposition); calls OpenAI |
| `backend/services/analytics/evidenceComputer.js` | Pure deterministic math: stats, correlations, deltas, anomalies, trends |
| `backend/services/charts/chartStrategyService.js` | Generates viable chart strategies from data + evidence; builds chart_data deterministically |
| `backend/services/charts/metricExtractor.js` | Shared: extractDailySeries, extractMultiMetricSeries, computeAverage, deriveUnit |
| `backend/services/qna/bundleService.js` | Creates/updates QnaBundle documents in MongoDB |
| `backend/services/qna/intentClassifierService.js` | Classifies utterances; extracts display_label, inferred_metrics |
| `backend/services/qna/auditService.js` | Audit logging |
| `backend/services/fitbit/endpointAdapters.js` | Maps raw Fitbit API responses to normalized rows |
| `backend/services/fitbit/metricResolver.js` | Maps user language to canonical metric keys and expands broad domain questions into richer metric bundles |
| `backend/models/QnaBundle.js` | Mongoose schema for QnaBundle |
| `backend/lambda/index.js` | Alexa Lambda — axios shim handles format translation and wake-word-friendly reprompt phrasing (DO NOT modify logic) |

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
  interaction: {
    mode: "generating",    // idle | generating | ready_to_deliver | awaiting_continue | complete
    requestId: "req_...",
    stageCount: 0,
    originalQuestion: "How did I sleep this week?",
    lastTurnType: "new_health_question",
    lastDeliveredFingerprint: "",
    generationStartedAt: "2026-03-27T...",
    readyAt: null,
  }
}
```

### MongoDB (persistent)

QnaBundle stores: question, plannerOutput, stages[], currentStageIndex, status, displayLabel.

### Router has NO state

The router is a pure request→response translator. All state lives in the orchestrator's `activeJobs` Map or MongoDB.

---

## Request Flow (Turn Resolution + Atomic Delivery)

**Problem solved:** ambiguous Alexa follow-ups like "okay", "thanks", or "I'm good" were being treated as new health questions, which interrupted the active bundle and created duplicate chart sets. Separately, charts could be pushed to the screen after timeout before Alexa spoke the matching narration.

**Solution:** every Alexa utterance is first resolved against backend interaction state by `alexaTurnResolver.js`. Ready stages are delivered through one atomic `deliverResult()` path that emits the current chart and returns the matching narration in the same turn. If the answer is not ready before the 6.5s gate closes, the backend returns `"Still working on that"` plus `smallTalk`, holds the stage until the next resumable turn, and later emits a screen-only `ready_to_resume` status when background generation completes so the user knows Alexa is ready to continue.

Resolver outcomes:
```javascript
await resolveAlexaTurn(...) => {
  kind: "new_health_question" | "resume_pending" | "navigation" |
        "small_talk_ack" | "ignore_chatter" | "cancel_reset" |
        "no_active_context_fallback" | "chart_qna",
  action: "show_more" | "back" | "start_over" | "resume_pending" | "chart_qna" | "",
}
```

Atomic delivery:
```javascript
async function deliverResult(result, { dedupeFrontendStage = false } = {}) {
  if (!dedupeFrontendStage || shouldEmitFrontendStage(username, result)) {
    emitResultToFrontend(username, result);
  }
  emitStatus(username, "completed", "Your health analysis is ready.", { ... });
  await orchestrator.markStageDelivered({ username, requestId, stageIndex, stageCount, ... });
  return lambdaReply(voiceForAlexa);
}
```

**Key rules:**
- Ambiguous short utterances during `generating` or `ready_to_deliver` default to resume, not new analysis.
- Navigation reuses the existing bundle only; it never regenerates charts.
- No post-timeout visual-only emit. A stage is emitted only when the same turn can return its narration.
- Post-timeout completion emits a backend-owned `ready_to_resume` full-screen accessibility state on the smart screen; the chart itself still waits for atomic voice+screen delivery.
- Delivery dedupe still uses `(username, requestId, stageIndex)`.
- `userPollState` still powers contextual `"Still working on that"` fillers.

One state store (`activeJobs`), one resume check (`resumePending`). No parallel Maps that can get out of sync.

---

## Stage Navigation (Conversational, Alexa-Driven)

The full chart bundle is authored upfront in one pass. Alexa delivers the authored stages one at a time in a conversational flow:

### Alexa Flow (Stage-by-Stage with Continuation Prompts)

```
User: "How's my sleep?"
Alexa: "[stage 0 narration]. When you're ready for the next chart, say, Alexa, next chart."
  → Screen shows chart 0

User: "Alexa, next chart"
Alexa: "[stage 1 narration]. When you're ready for the next chart, say, Alexa, next chart."
  → Screen shows chart 1

User: "Alexa, next chart"
Alexa: "[stage 2 narration]."
  → Screen shows chart 2

User: "Alexa, go back"
Alexa: "[stage 1 narration]. When you're ready for the next chart, say, Alexa, next chart."
  → Screen shows chart 1
```

`deliverResult()` in `alexaRouter.js` handles all of this:
1. Overrides auto-advance — returns only the current stage's `spokenText` (not combined SSML)
2. Appends `" When you're ready for the next chart, say, Alexa, next chart."` when more charts are available so Echo Dot users get a wake-word-friendly instruction
3. No "Chart X of Y" prefix — pure narration content only
4. Lambda appends `SmallPauseDuration` to keep the Alexa session open after each chart response

### Turn Resolution

Alexa turns are resolved in the backend with active interaction context, not by Lambda globals.

**Navigation fast path:** `detectNavigationAction()` in `alexaTurnResolver.js` uses regex patterns with health-keyword guards so phrases like "next, tell me about my sleep" are treated as a new health question rather than stage navigation.

```
"next"                    → show_more  (regex \bnext\b)
"show me the next chart"  → show_more  (regex \bnext\b, no health keywords)
"yes" / "sure" / "ok"    → show_more  (exact match for ambiguous words)
"let's move on"           → show_more  (regex \bmove on\b)
"go back"                 → back       (regex \bgo back\b)
"take me to the previous" → back       (regex \bprevious\b)
"start over"              → start_over (regex \bstart over\b)
```

**Interaction-aware routing:** once a bundle exists, the resolver also considers `interaction.mode`:
- `generating` / `ready_to_deliver`: "okay", "thanks", "I'm good", "haha" => resume, not interrupt
- `awaiting_continue`: "yes", "next", "go on", and even short acknowledgements => `show_more` when stages remain
- explicit health-data language => starts a new bundle and interrupts the current one
- `cancel`, `stop`, `never mind` => clear active interaction

### Chart Q&A (Voice-Only Follow-up)

While a chart is on screen, users can ask follow-up questions about it (e.g. "what do those points show", "which day had the most activity", "why did Wednesday spike", "did my heart rate drop on nights I slept well?"). These are answered with voice only — the chart on screen stays unchanged, and the stage index is not modified.

**Classifier categories:** `chartQnaClassifier.js` returns one of three categories:
- `chart_qna` — fully answerable from existing stored data
- `chart_qna_with_fetch` — same chart context but requires 1-2 extra metrics from the same time window; classifier also returns `supplemental_metrics: string[]` (up to 2 canonical keys)
- `new_health_question` — different topic/scope; triggers the full pipeline

**Detection flow:**
1. `resolveAlexaTurn` receives `chartContext` describing the current stage (title, chart_type, metrics, spoken_text).
2. When all of the following are true, the LLM classifier is invoked:
   - Active interaction with `mode` in `ready_to_deliver | awaiting_continue | complete`
   - Utterance looks like a question (starts with what/why/which/how/etc. and is 3+ words)
   - Not a navigation phrase, cancel, or small-talk acknowledgement
3. `chartQnaClassifier.js` calls GPT-4o-mini and returns `chart_qna`, `chart_qna_with_fetch`, or `new_health_question`. Both chart-follow-up categories resolve to `kind: "chart_qna"` on the turn object; `chart_qna_with_fetch` additionally carries `supplementalMetrics: []` on the resolved turn.
4. On `chart_qna`, the router calls `orchestrator.answerChartQuestion({ username, question, supplementalMetrics })` which:
   - Loads the current stage + stored `evidenceBundle` + `multiWindowData` from MongoDB
   - If `supplementalMetrics` is non-empty and those metrics are not already in the bundle, calls `fetchMultiWindowData` for those metrics using the current stage's time scope (no full pipeline, no planner, no chart generation)
   - Merges the fetched data into the stored `multiWindowData` and recomputes `evidenceBundle` using `buildEvidenceBundle`
   - Persists the enriched data back to the bundle (so subsequent follow-ups also benefit)
   - Calls `chartQnaAgent.js` with the merged evidence to generate a 1-3 sentence voice answer
   - Returns voice-only (no chart emit, no `markStageDelivered`, no stage index change)
5. On classifier failure or timeout, defaults to `new_health_question` (no regression).
6. If the supplemental fetch fails, the agent answers from the data it already has.

**Supplemental metric allowlist:** `sleep_minutes`, `sleep_deep`, `sleep_rem`, `sleep_light`, `sleep_awake`, `sleep_efficiency`, `resting_hr`, `hrv`, `steps`, `calories`, `distance`, `floors`. Any metric outside this list returned by the classifier is silently dropped.

**State invariants:** `activeJobs[user].currentChartIndex`, `bundle.currentStageIndex`, `userLastDeliveredStage`, and `userPollState` are all untouched during a chart_qna turn. Only `multiWindowData` and `evidenceBundle` in the MongoDB bundle document may be extended.

### Browser Path (Unchanged)

Browser-originated requests (`POST /browser-query`) still use auto-advance with browser TTS. The `chartAdvanceSchedule` is stripped at the router level. `buildCombinedVoiceAnswer()` and timer-based chart advancement in `QnAPage.js` remain available for browser use.

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

## Multi-Panel Display (`display_group`)

Stages with the same `display_group` integer are shown simultaneously on one screen as a multi-panel layout. Side-by-side panels are reserved for **genuinely different metric types** (e.g. sleep stages stacked_bar + efficiency gauge). For **comparison questions** (today vs yesterday, week 1 vs week 2), the planner uses a single combined chart with both time periods on the x-axis — it does NOT create separate per-period stages.

### Combined Charts vs Side-by-Side Panels

- **Combined chart (preferred for comparisons):** One stage with both time periods as x-axis categories (e.g. stacked_bar with "Apr 19" and "Apr 20"). Each metric set appears in at most one stage. This avoids duplication.
- **Side-by-side panels (for different metrics):** Multiple stages with the same `display_group`, used when metrics are incompatible (e.g. sleep stages + sleep efficiency). Each stage shows different metrics — never the same metrics repeated.

### Flow

1. **Planner** assigns `display_group` to each stage in `stages_plan`. Stages sharing a group appear together; stages with different groups appear on separate screens. The planner's grouping is trusted — no deterministic override.
2. **`ensureDisplayGroup`** in `plannerAgent.js` normalizes `display_group` to a valid integer (falls back to stage index) but does not rewrite the planner's grouping decisions.
3. **Executor (V3)** propagates `display_group` from `candidate.stage_spec` to `stage.metadata.display_group` in `normalizeAuthoredBundleStages`.
4. **`stageService.buildStagePayload`** groups stages by `metadata.display_group`, builds a `panels[]` array for each group, and sets `voice_navigation_only: false` when a group has multiple stages.
5. **Auto-advance guard:** `autoAdvance` is disabled for multi-panel groups so side-by-side panels remain visible instead of collapsing back to sequential single-chart playback.
6. **Frontend** (`QnAPage.js`) renders all panels in `visiblePanels` when `voice_navigation_only` is `false`, using CSS grid layouts (`two_up`, `two_up_plus_footer`, `four_panel_grid`). Single-panel fallback now only applies to `autoAdvance` when `voice_navigation_only` is not explicitly `false`.

### Layouts

| Panels in group | Layout | Description |
|---|---|---|
| 1 | `single_focus` | Full-screen single chart |
| 2 | `two_up` | Side-by-side panels |
| 3 | `two_up_plus_footer` | Hero chart top + two smaller below |
| 4 | `four_panel_grid` | 2x2 grid |

### Metric Compatibility Rules

Metrics with incompatible units or vastly different scales must NOT share a single stage/chart. Instead, they are split into separate stages with the same `display_group` for side-by-side display:

- **Forbidden:** percentage metrics (sleep_efficiency, spo2) with absolute metrics (minutes, steps, calories)
- **Forbidden:** metrics with >5x scale difference (steps ~10k vs floors ~10)
- **Correct:** sleep stages (stacked_bar) alongside sleep efficiency (gauge) — same `display_group`, separate stages
- **Correct:** steps (bar) alongside resting HR (line) — same `display_group`, separate stages

### No-Duplication Rules

- Each metric set appears in at most **one stage**. The planner never creates separate stages for the same `focusMetrics` split by time period.
- Comparison questions use one combined chart per metric group with both periods on the x-axis.

---

## QnA Frontend UI (`frontend/src/pages/QnAPage.js`)

The QnA screen shows a top bar (time, title, username) followed by the report title and takeaway description, then the chart panel grid.

**Removed elements:** Voice hint chips, "Chart X of Y" stage counter, and the "Your health analysis is ready" banner are no longer rendered.

**Status notices:** Only non-completed status messages (`slow`, `error`, `info`) appear as a banner. Messages with type `completed` or `ready_to_resume` are suppressed in the UI.

**Chart axis readability** (`echartsTheme.js`, `chartSpec.js`):
- Grid always uses `containLabel: true` with enforced minimum margins (left 72, right 36, top 44, bottom 68). These minimums are large enough to accommodate axis tick labels (16 px font) and axis name labels on all four sides without clipping.
- Axis label defaults: font size 16px, color `#1E293B`, margin 12px.
- Axis names use `nameLocation: 'middle'` (centers the label along the axis away from the edges) with role-specific `nameGap`: 40 px for x-axis (clears tick label height below the axis line) and 32 px for y-axis (pushes the rotated label left of tick values). Name text style: fontSize 14, fontWeight 500, color `#334155`.
- Axis label and name truncation limits raised to 32 characters. Long category labels auto-rotate 25 degrees when >5 labels exceed 10 chars. Time-axis labels with >12 points rotate 30 degrees.
- Line-series defaults now emphasize distinct points (`showSymbol: true`, circular markers) and no longer add implicit area-fill.
- Sleep minute-based series (e.g., `sleep_minutes`, sleep stage minutes, `wake_minutes`) are converted to hour display values in chart specs; y-axis naming prefers `Hours` when minute-based sleep context is detected.
- Cartesian charts ensure both axis names are present even when omitted upstream (`Time`/`Date` defaults for x-axis, `Value` fallback for y-axis). The Executor V4 is expected to always provide meaningful `xAxis.name`/`yAxis.name` values directly in `chart_option`; these frontend fallbacks only apply when the executor omits them.

**`list_summary` / `composed_summary` rendering** (`chartSpec.js`):
- `sanitizeListSummaryOption` now renders a full-canvas metric card grid using ECharts `graphic` elements instead of a tiny bullet list.
- Structured `cards` (`{ label, value, subvalue }`) from the backend option are preferred over plain text `items`. When only `items` are present, they are split on `":"` to extract label and value.
- Layout adapts to card count: 1 card → single centred column; 2 cards → side-by-side; 3-6 cards → 2-column grid.
- Font sizes scale with count: value labels range from 36 px (6 cards) to 64 px (1 card). Metric names are uppercased, muted (`#94A3B8`). Values are large and coloured using the shared accent palette.
- Each card's content is vertically centred around its grid cell midpoint.
- When no data is available a single "NO DATA AVAILABLE" card is shown rather than a fallback chart.

**`list_summary` V4 compatibility** (`optionValidator.js`, `agentConfigs.js`):
- `validateLLMGeneratedOption` no longer requires a `series` array for `list_summary` and `composed_summary` (they render via `graphic`, not series). These types now join `radar` in the no-series exception list.
- `ECHARTS_SKELETON_GUIDE` now includes a `LIST_SUMMARY` skeleton with `items` + `cards` structure.
- `EXECUTOR_SYSTEM_PROMPT_V4` OUTPUT FIELDS chart_type list and CHART TYPE SELECTION section now include `list_summary` with guidance on when to use it (latest-value snapshot, daily overview, sparse data).

**Single-panel chrome budget** (`tabletSingleView.css`):
- The chart grid in single-panel mode uses `calc(100vh - 220px)` (was 382 px). The 162 px reduction reflects the removal of voice hints (62 px), the ready-banner buffer (48 px), and the stage counter line from the report header (~20 px), plus reduced gap count (from 3×12 to 1×12).
- Minimum chart height remains 420 px to prevent blank renders on short screens.

**Executor V4 axis name requirement** (`agentConfigs.js`):
- `EXECUTOR_SYSTEM_PROMPT_V4` now explicitly requires `xAxis.name` and `yAxis.name` in every generated `chart_option`.
- `ECHARTS_SKELETON_GUIDE` skeletons for BAR, LINE, AREA, MULTI_LINE, STACKED_BAR, and GROUPED_BAR now include `name` placeholders (e.g., `"<x-axis label e.g. Date>"`, `"<metric + unit e.g. Steps per Day>"`).
- The axis name is the one-line on-screen explanation for what each axis represents, making charts immediately interpretable for older users without needing to read the legend.

---

## Question Archetypes

Beyond single-metric and comparison questions, the system now handles four archetypes:

### Relationship Questions
*"Does exercise help my sleep?", "Is there a link between my steps and heart rate?"*
- Intent classifier: sets `inferred_metrics` from BOTH domains, `time_range: last_14_days`
- Planner: 4-stage plan — trend A → trend B → `relationship_deep` stage (grouped_bar/scatter) → takeaway
- Evidence: Pearson correlation in `cross_analysis.correlations` provides the key insight
- Executor: narrates the relationship with cause-and-effect language

### Summary / Report Questions
*"Give me a health report", "How am I doing overall?", "Summarize my week"*
- Intent classifier: GENERAL WELLNESS metrics bundle, `time_range: last_7_days`
- Planner: 3-4 stage plan — radar overview → sleep stages → cross-domain relationship → `health_report` takeaway
- Evidence: `health_scorecard` (0-100 per-metric scores) structures the narration
- Executor: leads with highest-scoring metric, then areas needing attention

### Anomaly Questions
*"Is anything unusual?", "Any red flags?", "Should I be worried?"*
- Intent classifier: GENERAL WELLNESS bundle, `concern_level: concerned`
- Planner: 3-stage plan — radar overview → `anomaly_scan` bar → takeaway
- Evidence: `anomaly_summary` (aggregated z-score anomalies, `all_clear` flag) drives narration
- Executor: reassures if `all_clear: true`; narrates top findings with context if anomalies found

### Evaluative / Yes-No Questions
*"Has my sleep worsened?", "Am I active enough?", "Is my heart rate normal?"*
- All question archetypes — identified by evaluative language in the question
- Executor (FINAL stage only): appends a direct **Conversational Verdict** sentence
  - "So to summarize — your sleep has actually stayed fairly average this week, no real decline."
  - "In short — your activity has been on the lower side, but not dramatically below your usual pace."

---

## Design Principles

- **Alexa has no state** — all state is backend-managed (`activeJobs` Map + MongoDB)
- **Evidence-based reasoning** — LLM reasons over pre-computed facts, not raw rows
- **Deterministic chart data** — GPT picks strategy; backend builds numbers
- **Conversational verdicts** — evaluative questions always get a direct yes/no answer on the final stage
- **No duplicate smallTalk logic** — backend's `getContextualFiller()` generates topic-matched filler statements; Lambda uses backend's `smallTalk` directly if non-empty, falls back to own generic arrays. Old `countQuestion`-gated logic is commented out.

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
| `computeAnomalySummary(subAnalysisMap)` | `{ total_anomalies, flagged_metrics: [{ metric, date, value, zscore, direction, severity }], all_clear }` — aggregates all anomalies across sub-analyses, top 5 by zscore |
| `computeHealthScorecard(subAnalysisMap)` | `{ metrics: [{ metric, score, rating, latest, mean, trend_direction, unit }], overall_score, overall_rating }` — 0-100 score per metric vs healthy reference ranges |
| `buildEvidenceBundle(multiWindowData)` | Full evidence bundle: `{ sub_analyses, cross_analysis, anomaly_summary, health_scorecard }` |

These replace sending raw rows to GPT. The evidence bundle is ~30 lines of pre-computed facts vs 180 lines of raw numbers.

`anomaly_summary` and `health_scorecard` are automatically attached to every evidence bundle and flow to the executor, enabling anomaly/report question types without any additional data fetching.

---

## Chart Strategy Service (`backend/services/charts/chartStrategyService.js`)

**`generateViableStrategies({ stageSpec, multiWindowData, evidenceBundle, previousChartTypes })`**
- Generates 3-6 viable chart strategy descriptions per stage
- Cross-period strategies: `grouped_bar_cross_period`, `bar_with_reference`
- Single-analysis strategies: `line_trend`, `multi_line_comparison`, `bar_daily`, `area_trend`, `stacked_bar_sleep_stages`, `scatter_relationship`, `gauge_latest`, `radar_overview`, `list_summary_overview`, `composed_summary`
- **New strategies:** `heatmap_day_of_week` (7+ rows, metric pattern by day), `heatmap_multi_metric` (7+ rows, 3+ metrics, cross-day view), `donut_headline` (latest value at center with breakdown ring), `bar_anomaly_highlight` (bar with anomalous readings marked, shown when evidence contains anomalies)
- **Uses planner chart types as soft hints**: matching strategies are still ranked first, but the authored bundle executor may choose the strongest story arc across stages.
- Cross-stage dedup still prefers variety: each stage candidate is generated with the OTHER stages' chart hints as `previousChartTypes` so the bundle author sees diverse options.
- `list_summary` and `composed_summary` are heavily deprioritized (+3 penalty) — visual charts are always preferred

**`buildChartFromStrategy(strategyId, multiWindowData, evidenceBundle, viableStrategies)`**
- After GPT picks a `selected_strategy_id`, deterministically builds `chart_data`
- No hallucinated numbers — all chart data is backend-owned
- `heatmap` case: builds `{ xLabels, yLabels, data: [dayIdx, metricIdx, normalizedValue][] }` using `extractHeatmapData()`
- `donut` case: builds `{ slices, centerValue, centerLabel, unit }` using `extractDonutData()`
- `bar_anomaly_highlight` case: standard bar + `markPoints` array for anomalous dates

**Metric Extractor additions (`backend/services/charts/metricExtractor.js`):**
- `extractHeatmapData(rows, metricKeys, xMode)` — returns `{ xLabels, yLabels, data }` with normalized 0-100 values per metric
- `extractDonutData(rows, primaryMetric, sliceMetrics)` — returns `{ slices, centerValue, centerLabel, unit }`

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
      "goal": "",
      "display_group": 0
    }
  ]
}
```

## Planner Schema (PLANNER_TEXT_FORMAT — V1, active)

```json
{
  "metrics_needed": ["sleep_minutes", "sleep_deep", "sleep_efficiency"],
  "time_scope": "last_night",
  "analysis_goal": "string",
  "candidate_stage_types": ["sleep_stages", "sleep_detail"],
  "stages_plan": [
    {
      "stageIndex": 0,
      "stageType": "sleep_stages",
      "stageRole": "primary",
      "focusMetrics": ["sleep_deep", "sleep_light", "sleep_rem", "sleep_awake"],
      "chartType": "stacked_bar",
      "title": "Sleep Stages Breakdown",
      "goal": "Show composition of sleep stages",
      "display_group": 0
    },
    {
      "stageIndex": 1,
      "stageType": "sleep_detail",
      "stageRole": "deep_dive",
      "focusMetrics": ["sleep_efficiency"],
      "chartType": "gauge",
      "title": "Sleep Efficiency",
      "goal": "Show sleep efficiency percentage as a clear dial",
      "display_group": 0
    }
  ]
}
```

---

## Executor Schema (EXECUTOR_TEXT_FORMAT_V3)

| Field | Source | Purpose |
|---|---|---|
| `evidence` | evidenceComputer.js | Pre-computed stats, anomalies, correlations, deltas |
| `bundle_candidates` | executorAgent.js | Ordered stage slots with goal, focus metrics, and viable strategy choices |
| `stages[].selected_strategy_id` | GPT output | Which strategy to build each stage's chart_data from |
| `bundle_thread` | GPT output | Shared narrative through-line across all stages |

GPT uses evidence for narration, authors the full bundle as one coherent answer, picks one strategy per stage, and the backend builds chart_data deterministically.

---

## Lambda ↔ Backend Compat Layer

The Lambda sends raw JSON-string bodies (`JSON.stringify(question)`) with `Content-Type: application/json`.

### Backend-side responsibilities (alexaRouter.js `handleLambdaRequest`)

1. **Body parsing** — `req.body` is a JS string after `express.json({ strict: false })`. Strips `start ` prefix and `user query:` context wrapper.
2. **Turn resolution** — `resolveAlexaTurn()` maps each utterance to `new_health_question`, `resume_pending`, `navigation`, `small_talk_ack`, `ignore_chatter`, `cancel_reset`, or `no_active_context_fallback`.
3. **Interaction-aware interruption policy** — while a bundle is active, only explicit health-data questions can interrupt it. Short acknowledgements and chatter resume or continue the current bundle instead.
4. **Atomic stage delivery** — `deliverResult()` is the only Alexa path that emits a chart and returns the matching narration. It also records delivery back into orchestrator interaction state.
5. **Idempotent stage delivery guard** — `userLastDeliveredStage` stores the last `(username, requestId, stageIndex)` fingerprint and timestamp. Resume/navigation delivery uses `dedupeFrontendStage: true` to avoid replaying the same websocket stage.
6. **6.5s backend gate** — new questions await the pipeline for up to 6.5s (backend holds the connection). Lambda's axios timeout is 7s. If pipeline isn't ready after 6.5s, returns `"Still working on that"` with progressive `smallTalk` fillers, holds the ready stage for the next resumable turn, and when generation later completes emits a `status: ready_to_resume` full-screen smart-screen message telling the user to say "Alexa, continue" to hear it.
7. **Response format** — replies with `{ GPTresponse, smallTalk }`. When `GPTresponse` is `"Still working on that"`, `smallTalk` contains a backend-generated statement. Lambda now consistently prefers backend `smallTalk` across its active handlers and only falls back to local filler text when `smallTalk` is empty. When `GPTresponse` is the stage narration, `smallTalk` is empty and the current chart is emitted in the same turn.
8. **Browser-query isolation** — `/browser-query` remains websocket-driven and strips Alexa-specific auto-advance timing.
9. **Lambda reprompts** — the Lambda speech strings now avoid bare prompts like "say yes" or "just say anything" and instead tell Echo Dot users to begin again with "Alexa".

---

## Design Principles

- **Alexa is not responsible for state management.** All state lives in the backend (activeJobs Map + MongoDB).
- **Chart data is deterministic and backend-owned.** GPT picks a strategy, but never generates chart numbers.
- **Evidence replaces raw rows.** GPT receives pre-computed stats and strategy candidates instead of raw data rows.
- **One authored bundle per question.** `generateAllStages()` now makes one bundle-authoring request, then normalizes that authored answer into ordered stages. If an authored stage is missing or unusable, only that stage falls back.
- **Voice first, screen second.** Each stored stage remains a self-contained chart+narration slice that can be delivered atomically.
- **Coherence is prompt-owned.** The executor prompt is responsible for making the stages feel like one answer arc instead of isolated chart captions.
- **Inference is preserved.** Each stage must not only describe the current chart but also explain the inferred pattern and why that metric matters in plain language.
- **Cross-metric inference.** Broad questions trigger cross-domain analysis with correlation-based narration.
- **Metric compatibility & no duplication.** Metrics with incompatible units or vastly different scales are split into separate stages with the same `display_group` for side-by-side display. Comparison questions use combined charts (both periods on one x-axis) — never separate per-period stages for the same metrics.
- **Single pipeline.** No V2/V3 split. One flow for all questions.
- **No duplicate responses.** Single pipeline await, single state store, single resume check.
- **Planner guidance is soft.** The planner still provides stage coverage and chart hints, but the authored bundle executor decides the final chart sequence and narration as one story.
- **Broad questions expand to domain bundles.** For example, sleep evaluative questions widen from a single sleep metric to a fuller sleep bundle plus useful context metrics when evidence supports it.
- **Final stage answers the question directly.** Evaluative questions should end with an explicit yes/no style verdict grounded in the visible charts.
- **Atomic chart+narration delivery.** Alexa stages are emitted only when the same turn can also return the matching narration.
- **Alexa is the narrator.** Browser TTS is only used for browser-originated requests. Alexa delivers charts one at a time with continuation prompts — the user controls the pace by saying "yes", "next", or "go back".
