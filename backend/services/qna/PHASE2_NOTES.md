# QnA Agent Migration - Phase 2 Notes

## What Phase 2 Added

- `backend/configs/agentConfigs.js`
  - Planner model config, timeout/token settings, planner system prompt.
  - Planner JSON schema/text format for strict structured output.

- `backend/services/openai/responsesClient.js`
  - Generic OpenAI Responses API wrapper.
  - Supports model, input, instructions, response format, previous response id, tools placeholder, timeout, and trace logging.

- `backend/services/openai/plannerClient.js`
  - `runPlannerRequest({ question, activeBundleSummary, userContext })`.
  - Calls Responses API wrapper.
  - Validates/sanitizes planner output and falls back safely when model output is invalid/unavailable.

- `backend/services/qna/plannerAgent.js`
  - `planQuestion({ question, username, activeBundle, userContext })`.
  - Builds compact active bundle summary.
  - Normalizes planner output into stable internal fields for bundle storage.

- `backend/services/qna/qnaOrchestrator.js`
  - `runPlannerShadow({ username, question, activeBundle })`
  - `buildActiveBundleSummary(bundle)`
  - `storePlannerResultInBundle(bundleId, plannerResult)`
  - Shadow-mode planner flow with conservative bundle persistence behavior.

## Where Planner Runs

- Planner is integrated in **shadow mode** via:
  - `backend/routers/alexaRouter.js`
  - `backend/routers/aiRouter.js`
- Sidecar hook is fire-and-forget and runs on:
  - new Alexa question job
  - browser query route
  - follow-up route
  - `POST /api/ai/qna-ask` route

## Shadow-Mode Safety Behavior

- Planner output does **not** change live spoken answer generation.
- Planner output does **not** change chart spec generation.
- Existing `qnaEngine` live response path remains unchanged.
- If Mongo is not ready or planner fails, shadow planner skips/falls back without affecting user flow.

## Bundle Fields Populated in Phase 2

- `plannerOutput` now stores normalized planner payload + metadata.
- `metricsRequested` is updated from planner metrics.
- New bundles are created for new analysis intent when needed.
- Existing bundles are kept conservative (no destructive replacement in this phase).

## What Remains for Phase 3

- Wire orchestrator as the primary runtime entrypoint (not shadow-only).
- Add continuation/branch policy for selecting/releasing active bundles.
- Connect planner output to staged executor generation.
- Use `previous_response_id` in executor flow for progressive stage output.
- Keep Alexa timing and ECharts path stable during migration.
