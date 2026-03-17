# QnA Agent Migration - Phase 6 Notes

## What Phase 6 Changed

- Orchestrator now treats executor generation as the default stage path for both first-stage and follow-up progression.
- Added explicit Phase 6 orchestration helpers in `qnaOrchestrator.js`:
  - `generateOrReplayStage(...)`
  - `generateNextMissingStage(...)`
  - `finalizeBundleIfDone(...)`
  - `handleFollowupWithOrchestrator(...)`
- Stage delivery is now replay-first:
  - replay stored stage when available
  - only generate when stage is missing
  - generate one stage at a time and chain through `previous_response_id`
- Missing target stages are generated on demand through executor chaining (bounded by configured max stage count).
- Bundle lifecycle transitions are now cleaner for staged exploration:
  - active -> partial while more stages exist
  - partial/ready/completed on final stage based on config

## Executor As Primary Path

- `handleQuestionWithOrchestrator(...)` now resolves a target stage and routes through `generateOrReplayStage(...)`.
- `handleNavigationControl(...)` now routes through `generateOrReplayStage(...)` and only generates when replay cannot satisfy the request and generation is allowed for that action.
- `handleFollowupWithOrchestrator(...)` classifies follow-up intent and routes to:
  - navigation actions (`stage_next`, `stage_back`, `stage_replay`, `stage_goto`) when appropriate
  - full orchestrated planner+continuation+executor flow otherwise

## Replay vs Generation Rules

1. If requested stage exists in bundle memory: replay immediately.
2. If requested stage is missing:
   - generate exactly one missing next stage
   - persist stage and executor response id
   - repeat until target stage is reached or executor indicates completion/no more stages.
3. If executor cannot produce the stage:
   - preserve legacy fallback path according to config toggles.

## Fallback That Remains

- Legacy `qnaEngine` stage generation remains as a safety net.
- New config flags control fallback behavior:
  - `USE_EXECUTOR_PRIMARY` (default true)
  - `USE_LEGACY_STAGE1_FALLBACK` (default true)
  - `USE_LEGACY_NAV_FALLBACK` (default true)
- Router follow-up endpoint now tries orchestrator-first and still falls back to payload-based legacy follow-up when needed.

## Tooling and Safety Updates

- Expanded read-side executor tools in `toolLoop.js` with strict validation and allow-list enforcement:
  - `load_bundle` / `load_bundle_snapshot`
  - `get_stage_history`
  - `get_normalized_table` / `get_normalized_bundle_data`
  - `get_user_context`
  - `fetch_additional_fitbit_data` (guarded callback only)
- Write tools remain policy-gated and explicitly allow-listed. No unrestricted write expansion was introduced.

## Phase 7 Next Steps

1. Tighten authorization-aware write-tool policy and audit trails beyond allow-list checks.
2. Add stronger concurrent-request race protection for multi-device session control.
3. Improve follow-up intent coverage (slot-aware stage addressing and richer branch continuation semantics).
4. Add integration tests around Alexa router follow-up + navigation + fallback timing behavior.
