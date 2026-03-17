# QnA Agent Migration - Phase 3 Notes

## What Phase 3 Added

- `backend/services/qna/qnaOrchestrator.js`
  - Promoted to primary coordinator for question handling.
  - Adds:
    - `handleQuestionWithOrchestrator(...)`
    - `resolveBundleAction(...)`
    - `startNewBundleFromPlanner(...)`
    - `continueExistingBundle(...)`
    - `branchBundle(...)`
    - `persistStageResult(...)`
  - Preserves safe fallback to legacy `qnaEngine.answerQuestion(...)`.

- `backend/services/qna/continuationAgent.js`
  - Adds `classifyContinuation(...)` to normalize decision into:
    - `continue`
    - `branch`
    - `new`
  - Uses planner mode + deterministic phrase checks.

- `backend/services/qna/stageService.js`
  - Standardizes stage records from legacy payloads.
  - Adds:
    - `buildStageFromLegacyPayload(...)`
    - `createStageRecord(...)`
    - `appendStageToBundleFormat(...)`
    - `extractStageSummary(...)`

- `backend/services/qna/sessionService.js`
  - Lightweight session helpers for orchestrator state:
    - active bundle id
    - current stage index
    - latest request key (stale protection support)

- `backend/services/qna/bundleService.js` refinements
  - Added bundle transition helpers:
    - `setBundleStatus(...)`
    - `storePlannerResult(...)`
    - `createBranchBundle(...)`
  - Added parent linkage support through `parentBundleId`.

## Router Integration

- Primary question routes now call orchestrator first:
  - `backend/routers/alexaRouter.js` question job path
  - `backend/routers/alexaRouter.js` browser-query path
  - `backend/routers/aiRouter.js` `/qna-ask`

- Follow-up path remains on existing follow-up logic for safety.

## Bundle Action Policy

- `continue_analysis` -> continue active bundle and update planner data.
- `branch_analysis` -> create branch bundle linked via `parentBundleId`.
- `new_analysis` -> create new bundle (old bundle is not auto-destroyed).

## Stage 1 Source

- Stage 1 still uses legacy `qnaEngine.answerQuestion(...)` output.
- Orchestrator wraps that output into stage format and persists it.
- Alexa timing and current ECharts payload path remain unchanged.

## What Remains for Phase 4

- Replace legacy stage generation with executorAgent stages incrementally.
- Add explicit archive/release policy for older active bundles.
- Introduce multi-stage progression beyond stage 1.
- Expand continuation flow to support executor response chaining.
