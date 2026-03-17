You are working in an existing Node.js + React + Alexa + Fitbit + OpenAI codebase.

Goal:
Refactor the QnA system toward a simpler agentic architecture where GPT does the reasoning/calculations/inferences, while the backend only handles:
- Fitbit data fetch
- light normalization of Fitbit endpoint shapes
- bundle memory/state
- orchestration
- chart spec validation/render handoff to ECharts
- Alexa + screen transport

IMPORTANT:
Do NOT build a heavy backend generic analysis engine right now.
Do NOT create a complex runAnalysis/trend/comparison/relationship registry unless absolutely required.
The purpose of this prototype is to test the system concept in theory, not over-engineer the analytics layer.

Target architecture:
1. Planner GPT
   - decides whether the input is:
     - new analysis
     - continue current analysis
     - branch from current analysis
   - decides Fitbit metrics needed
   - decides time scope
   - decides high-level analysis goal
   - outputs a compact summary bundle plan in strict JSON

2. Bundle memory
   - stored in MongoDB
   - one active bundle per user/session analysis
   - stores:
     - bundle id
     - username
     - question
     - planner output
     - fetched raw Fitbit cache
     - lightly normalized table/series
     - stages already generated
     - active executor response id
     - bundle status
     - timestamps

3. Executor GPT
   - takes the summary bundle + current user input
   - does the reasoning/calculations/inferences in the model
   - chooses what to display next
   - chooses chart type/spec
   - emits one stage at a time, not one giant result
   - decides whether more stages are available
   - decides whether the new user utterance is continuing the current flow or starting a new one

4. Backend
   - fetches Fitbit data
   - lightly normalizes different Fitbit JSON endpoint shapes into a consistent form that GPT can read
   - stores/loads/releases bundles
   - validates chart specs before sending to frontend
   - preserves current Alexa timing behavior
   - preserves current ECharts rendering path

5. Frontend
   - keep current ECharts-based rendering
   - keep current QnAPage working
   - do not do a large UI rewrite right now

Existing constraints:
- current alexaRouter and lambda flow should not break
- current working behavior should be preserved as much as possible
- this should be migrated incrementally
- keep log messages/debuggability
- use CommonJS in backend if that matches repo
- prefer modifying existing structure carefully, but create new architecture files where needed

What to build now:
Create or refine the code structure for this lighter planner/executor architecture.

Desired file structure:
backend/
  configs/
    agentConfigs.js
    chartConfigs.js
    fitbitMetricMap.js

  models/
    QnaBundle.js

  services/
    qna/
      qnaOrchestrator.js
      plannerAgent.js
      executorAgent.js
      continuationAgent.js
      bundleService.js
      stageService.js
      sessionService.js

    openai/
      responsesClient.js
      plannerClient.js
      executorClient.js
      toolLoop.js

    fitbit/
      fitbitClient.js
      endpointAdapters.js
      normalizeSeries.js
      metricResolver.js

    charts/
      chartSpecBuilder.js
      chartTheme.js
      chartValidator.js

  routers/
    qnaToolsRouter.js

Important implementation guidance:
- The backend should NOT do heavy generic calculation modules.
- GPT should do most of the reasoning and calculations from the lightly normalized Fitbit data.
- endpointAdapters.js and normalizeSeries.js should only normalize endpoint shapes enough to make the data readable and consistent for GPT.
- The executor should return one stage at a time:
  - spoken_text
  - screen_text
  - chart_spec
  - more_available
  - suggested_followups
- Keep ECharts as the renderer.
- Do not ask GPT to return raw frontend code.
- The chart output should stay as chart JSON/spec consumed by frontend.

Bundle model requirements:
Implement QnaBundle with fields for:
- bundleId
- username
- status
- question
- plannerOutput
- metricsRequested
- rawFitbitCache
- normalizedTable
- stages
- executorResponseId
- currentStageIndex
- createdAt
- updatedAt
- completedAt (optional)

Bundle service requirements:
Implement:
- createBundle
- getBundleById
- loadActiveBundleForUser
- saveBundlePatch
- appendStage
- setCurrentStageIndex
- markBundleComplete
- releaseBundle

Use reusable bundle statuses for active lookup, such as:
- active
- partial
- ready

markBundleComplete in this phase should be status-only.

Planner requirements:
Implement plannerAgent/plannerClient to output strict JSON:
- mode: new_analysis | continue_analysis | branch_analysis
- metrics_needed
- time_scope
- analysis_goal
- candidate_stage_types

Executor requirements:
Implement executorAgent/executorClient scaffolding so executor can:
- consume bundle memory
- use previous_response_id
- produce one next stage
- reason from normalized Fitbit data
- choose calculations/inferences itself
- choose what chart to show itself

Continuation requirements:
Implement continuationAgent to decide whether a new utterance:
- continues current bundle
- branches current bundle
- starts a new bundle

OpenAI requirements:
Use Responses API-oriented structure.
responsesClient should support:
- previous_response_id
- function/tool calling scaffolding
- parallel tool calls where appropriate
- background mode scaffolding if useful
But do not fully replace current production path yet unless safe.

Migration behavior:
Do NOT rip out the current qnaengine/alexaRouter working flow right now.
Preserve current behavior.
This task should mostly:
- scaffold and partially wire the new architecture
- keep the old behavior working
- add comments/TODOs for future migration

Add a migration document:
Create a file such as:
- docs/qna-agent-migration.md
or
- backend/services/qna/MIGRATION_PLAN.md

This document must clearly explain:
- current architecture
- new lighter planner/executor architecture
- what was scaffolded
- what remains to migrate
- phased order of migration

Deliverables:
1. Create/update the files needed for this lighter architecture.
2. Add real code scaffolding with exports, signatures, and detailed human-readable comments.
3. Preserve current app behavior.
4. Add concise logs where helpful.
5. Output a summary of:
   - files created
   - files modified
   - what phase is complete
   - what should be done next

Very important:
- do NOT build a complex generic analysis backend
- do NOT over-engineer
- do NOT break Alexa flow
- do NOT break existing ECharts rendering
- prioritize clean architecture scaffolding and incremental migration