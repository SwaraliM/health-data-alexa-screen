# QnA Agent Migration - Phase 4 Notes

## What Phase 4 Added

- `backend/services/qna/executorAgent.js`
  - Adds executor-backed single-stage generation:
    - `generateStageFromExecutor(...)`
    - `generateInitialStage(...)`
    - `generateNextStage(...)`
  - Consumes bundle memory and normalized Fitbit table rows.
  - Normalizes executor output into stage records.

- `backend/services/openai/executorClient.js`
  - Adds a thin Responses API wrapper for executor requests.
  - Supports:
    - `previous_response_id` chaining
    - strict JSON stage schema
    - lightweight tool loop integration
    - timeout budget tied to Alexa voice deadline

- `backend/services/openai/toolLoop.js`
  - Adds a lightweight, bounded tool loop with simple tools:
    - `load_bundle_snapshot`
    - `get_normalized_bundle_data`
    - `mark_bundle_complete` (optional callback)
    - `append_stage_note` (optional callback)
  - Includes TODO notes for Phase 5 richer tool policy.

- `backend/services/qna/stageService.js`
  - Expanded with executor-focused helpers:
    - `normalizeExecutorStageOutput(...)`
    - `buildLegacyFallbackStage(...)`
    - `getCurrentStage(...)`
    - `getNextStageIndex(...)`
    - `buildStagePayload(...)`
  - Keeps chart validation through `chartSpecService.validateChartSpec(...)`.

- `backend/services/qna/bundleService.js`
  - Adds explicit lifecycle + executor state helpers:
    - `archiveOlderActiveBundles(username, keepBundleId)`
    - `releaseBundle(bundleId, reason?)`
    - `saveExecutorState(bundleId, { executorResponseId, currentStageIndex })`
  - Adds support for `archived` status and lineage metadata updates.

- `backend/services/qna/continuationAgent.js`
  - Refined continuation classification with stronger contextual signals.
  - Still returns the same decision shape (`continue`, `branch`, `new`) with reasons.

- `backend/services/qna/qnaOrchestrator.js`
  - Promoted to Phase 4 executor-first coordinator.
  - Flow now:
    1. planner + continuation
    2. bundle action resolve
    3. bundle lifecycle policy apply for new analysis
    4. Fitbit fetch + lightweight normalization into bundle
    5. executor stage generation (stage 1 first, stage 2/3 on continuation)
    6. fallback to legacy `qnaEngine.answerQuestion(...)` if executor fails/times out
    7. stage persistence + executor response id persistence
  - Preserves router contracts.

- `backend/configs/agentConfigs.js`
  - Adds executor prompt/config/schema:
    - model, temperature, timeout, token limits
    - strict stage output JSON schema
    - allowed chart type guardrails

## Runtime Behavior After Phase 4

- Stage 1 can be generated via executor when `QNA_EXECUTOR_STAGE_ENABLED` is not `"false"`.
- Legacy generation still exists and is used automatically on executor failure/timeout.
- Executor response chaining is stored in `bundle.executorResponseId`.
- Continuation requests can progress from stage 1 to stage 2/3 using the same bundle.
- Alexa/router timing UX remains polling-first with loading/progress/completion events unchanged.
- ECharts rendering path remains unchanged; executor chart output is validated/sanitized before payload.

## Bundle Archive/Release Policy

- New analysis applies explicit lifecycle policy (`QNA_BUNDLE_LIFECYCLE_POLICY`):
  - `archive` (default): older active bundles are archived (auditable, not deleted)
  - `release`: older active bundle is explicitly released
  - `none`: skip lifecycle transition (logged)
- Branch flow creates a linked bundle (`parentBundleId` + lineage metadata) and does not silently destroy the source bundle.

## What Remains for Phase 5

- Expand tool loop capabilities behind tighter policy/authorization.
- Add more robust multi-stage retrieval controls (e.g., replaying saved stage N without regen).
- Add optional richer executor prompts for multi-panel progressive narratives.
- Add dedicated tests for executor success path with mocked Responses API.

