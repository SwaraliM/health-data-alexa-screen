# QnA Agent Migration - Phase 1 Notes

## What Phase 1 Added

- `backend/models/QnaBundle.js`
  - Mongo model for one QnA analysis bundle.
  - Includes lifecycle status, planner output, raw Fitbit cache, normalized table, and stage tracking fields.
  - Adds indexes for `bundleId`, `username`, `status`, and `updatedAt`.

- `backend/services/qna/bundleService.js`
  - Persistence helpers for bundle lifecycle:
    - `createBundle`
    - `getBundleById`
    - `loadActiveBundleForUser`
    - `saveBundlePatch`
    - `appendStage`
    - `setCurrentStageIndex`
    - `markBundleComplete`
    - `releaseBundle`
    - `touchBundle`
  - Active lookup uses: `active`, `partial`, `ready`.

- `backend/services/fitbit/endpointAdapters.js`
  - Lightweight per-endpoint adapters that normalize Fitbit payload shapes into:
    - `timestamp`
    - `label`
    - `metric`
    - `value`
    - `meta`

- `backend/services/fitbit/normalizeSeries.js`
  - Lightweight helpers to:
    - group series by metric
    - align by timestamp
    - build a normalized wide table
    - preserve ordering and missing values

- `backend/services/fitbit/metricResolver.js`
  - Deterministic concept/alias -> metric mapping.
  - No GPT usage.

## What Current Runtime Still Uses

- Existing live QnA behavior still runs through:
  - `backend/services/qnaEngine.js`
  - `backend/routers/alexaRouter.js`
  - current ECharts payload path
  - current Fitbit router endpoints

- Phase 1 does **not** replace or remove existing QnA execution flow.
- Phase 1 files are additive migration foundations.

## TODO for Phase 2

- Wire orchestrator entry points to start using `bundleService`.
- Attach endpoint adapter calls inside the future planner/executor fetch path.
- Store adapted + normalized tables in `QnaBundle.normalizedTable`.
- Add continuation/branch handling on top of active bundle lookup.
- Introduce stage-by-stage executor flow while preserving Alexa timing behavior.
