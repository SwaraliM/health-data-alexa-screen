# QnA Agent Migration - Phase 5 Notes

## What Phase 5 Added

- `backend/services/qna/stageService.js`
  - Added deterministic replay helpers:
    - `getStageByIndex(bundle, stageIndex)`
    - `hasStoredStage(bundle, stageIndex)`
    - `getLatestStage(bundle)`
    - `normalizeRequestedStageIndex(input, maxStageIndex)`
    - `buildReplayResponse(...)`
    - `replayStoredStage(...)`
  - Replay now returns the same `buildStagePayload(...)` shape used by the existing ECharts path.

- `backend/services/qna/qnaOrchestrator.js`
  - Added navigation/replay orchestration:
    - `handleStageReplay(...)`
    - `handleNavigationControl(...)`
    - `maybeReplayStoredStage(...)`
  - Added dependency injection hooks to improve testability for executor path and fallback path.
  - Navigation behavior now prefers stored stages and only generates when a requested stage is missing.

- `backend/services/qna/sessionService.js`
  - Added stage-navigation state support:
    - `requestedStageIndex`
    - `setRequestedStageIndex(...)`
    - `applyStageReplayState(...)`
    - `getActiveBundleId(...)`
  - Kept existing session keys and behavior backward-compatible.

- `backend/routers/alexaRouter.js`
  - Added explicit navigation controls + aliases:
    - `stage_next` / `next` / `show_more`
    - `stage_back` / `back`
    - `stage_replay` / `replay`
    - `stage_goto` / `go_to_stage` / `goto_stage`
  - Router now delegates navigation to orchestrator and emits unchanged payload shape for frontend/websocket consumers.

- `backend/services/openai/toolLoop.js`
  - Added explicit tool-policy guardrails:
    - `isWriteTool(toolName)`
    - `isAllowedTool(toolName, policy)`
    - `validateToolCall(toolName, args)`
    - `executeToolCall(toolName, args, ctx)`
  - Added strict argument validation and policy-based allow/deny checks.
  - Added write-side attempt logging for auditability.

- `backend/services/openai/executorClient.js`
  - Added cleaner response normalization:
    - `normalizeExecutorResponse(...)`
    - safe JSON fallback extraction from `outputText`
  - Added dependency injection hooks (`__deps`) for tests.
  - Wired executor tool policy into `getExecutorTools(...)` and `runToolLoop(...)`.

- `backend/configs/agentConfigs.js`
  - Added explicit executor tool policy config:
    - `EXECUTOR_READ_TOOLS`
    - `EXECUTOR_WRITE_TOOLS`
    - `executor.toolPolicy` with:
      - `allowedReadTools`
      - `allowedWriteTools`
      - `availableWriteTools`
      - `writeEnabled`
      - `requireExplicitWriteAllowList`

## Tests Added (No Live Network)

- `backend/services/qna/__tests__/qnaOrchestrator.test.js`
  - planner `new_analysis` -> new bundle path
  - planner `continue_analysis` -> continue existing bundle path
  - executor timeout -> legacy fallback stage path
  - navigation replay uses stored stage without regeneration
  - navigation generates only when requested stage is missing

- `backend/services/qna/__tests__/executorAgent.test.js`
  - executor stage normalization
  - response-id chaining through `previousResponseId`
  - safe failure envelope on executor failure

- `backend/services/openai/__tests__/executorClient.test.js`
  - request normalization and tool policy handoff
  - invalid output handling
  - timeout/error passthrough behavior

- `backend/services/openai/__tests__/toolLoop.test.js`
  - write-tool classification and policy denial
  - strict tool argument validation
  - allowed write execution
  - tool loop request chaining behavior

- `backend/services/qna/__tests__/stageReplay.test.js`
  - stored stage replay determinism
  - index normalization/clamping behavior
  - latest-stage and stored-stage lookup helpers

## Runtime Behavior After Phase 5

- Stored stage replay/navigation no longer requires regeneration when stage already exists.
- Orchestrator can now explicitly replay or navigate stages with deterministic payload output.
- Executor write-side tools are now policy-gated and validated before execution.
- Legacy fallback path remains intact for executor failures.
- Existing Alexa timing flow, websocket payload shape, and ECharts rendering contract remain unchanged.

## What Remains for Phase 6

- Add stronger authorization/identity-aware write-tool gating beyond static allow-lists.
- Expand stage-navigation semantics for richer natural-language navigation intents and Alexa slot-based stage targeting.
- Add deeper stale request/bundle race protections for multi-device concurrent interactions.
- Introduce broader write-side tools only after stronger guardrails and audit/reporting UX are in place.
