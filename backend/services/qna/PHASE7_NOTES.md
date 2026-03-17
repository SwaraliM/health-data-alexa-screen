# QnA Agent Migration - Phase 7 Notes

## Phase 7 Outcome

The lightweight agentic QnA architecture is now functionally complete for prototype/study usage.

Primary runtime remains:
- planner -> continuation -> bundle action -> executor/replay -> fallback safety net
- Alexa timing path, websocket payloads, and ECharts rendering contracts are preserved

## Write-Tool Gating Hardening

`backend/services/openai/toolLoop.js` now enforces stronger write controls:
- explicit read vs write tool classification
- `canExecuteWriteTool(...)` request-context checks:
  - `username`
  - `bundleId`
  - `requestKey`
  - `source` (`alexa`, `web`, `followup`, `internal`)
- policy-aware source and allow-list enforcement
- write ownership callback checks (`canWriteToBundle(...)`) before mutations
- strict per-write validation via `validateWriteToolArgs(...)`
- clear denied-write error responses (policy/context/ownership/validation)

Supported write aliases now include:
- `mark_bundle_complete`
- `append_note` / `append_stage_note` / `add_bundle_note`
- `append_stage`
- `release_bundle`

## Audit Trail Added

`backend/services/qna/auditService.js` was added as a lightweight structured audit layer.

Recorded event categories include:
- allowed write attempts
- denied write attempts
- concurrent request detections
- stale result discards

Audit records include:
- `username`
- `bundleId`
- `requestKey`
- `toolName` (for tool events)
- `argsSummary`
- `allowed`
- `result`
- `reason`
- `source`
- `timestamp`

## Concurrency and Race Protection Hardening

### Session-level protections
`backend/services/qna/sessionService.js` now tracks:
- active request lifecycle (`beginRequest`, `endRequest`)
- active/latest request key per user
- request ownership per bundle (`setRequestBundleOwnership`)
- current request checks (`isCurrentRequest`)
- active session snapshot helper (`getActiveSessionState`)

### Bundle-level protections
`backend/services/qna/bundleService.js` now supports:
- request ownership metadata persistence (`setBundleRequestOwnership`)
- stale-request-aware write guards (`ensureWriteAllowed`, `rejectStaleRequest`)
- optional optimistic write checks on `updatedAt`
- guarded stage/status patching in concurrent flows

### Orchestrator/router protections
- `qnaOrchestrator` now begins/ends tracked requests, binds request->bundle ownership, and rejects stale executor/fallback results when strict stale rejection is enabled.
- `alexaRouter` now discards superseded async job results so older responses cannot overwrite newer screen state.

## Follow-up Intent Coverage Expansion

`backend/services/qna/continuationAgent.js` now classifies richer follow-up intents with normalized output:
- `intentType`
- `bundleAction`
- `targetStageIndex`
- `requiresGeneration`
- `canReplay`
- `normalizedQuestion`

Coverage now includes:
- show more / next
- back
- replay that
- show stage N
- explain that / what does this mean
- summarize this
- compare that
- what about X now
- does Y affect that too
- start over

Routing behavior:
- clean navigation/replay requests -> replay/navigation path
- generation-needed continuations -> executor stage generation
- branch-like topic shifts -> branch bundle path
- explicit reset/new-topic -> new bundle path

## Integration Test Coverage Added

New/expanded tests include:
- `backend/services/openai/__tests__/toolLoop.policy.test.js`
- `backend/services/qna/__tests__/continuationAgent.test.js`
- `backend/services/qna/__tests__/sessionRaceProtection.test.js`
- `backend/services/qna/__tests__/qnaOrchestrator.integration.test.js`
- `backend/tests/alexaRouter.fallback.test.js`

Covered scenarios include:
- executor success path
- executor timeout -> fallback path
- stale async result rejection
- replay vs regeneration behavior
- expanded follow-up intent routing
- write-tool allowed/denied policy behavior
- Alexa timing-sensitive resume flow and concurrent request supersession

## What Remains After Phase 7 (Polish Only)

Remaining work is non-blocking polish:
- prompt tuning and follow-up phrasing quality improvements
- audit retention/forwarding strategy (if persistent storage is needed later)
- UX copy tuning for stale/concurrency edge cases
- observability dashboards/alerts for production hardening
- cleanup/refactoring pass once migration stabilizes
