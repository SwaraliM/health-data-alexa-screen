const test = require("node:test");
const assert = require("node:assert/strict");

const executorAgentPath = require.resolve("../executorAgent");
const executorClientPath = require.resolve("../../openai/executorClient");

function loadExecutorAgentWithMock(mockRunExecutorRequest) {
  const originalExecutorClient = require.cache[executorClientPath];
  delete require.cache[executorAgentPath];
  require.cache[executorClientPath] = {
    id: executorClientPath,
    filename: executorClientPath,
    loaded: true,
    exports: {
      runExecutorRequest: mockRunExecutorRequest,
    },
  };

  const agent = require("../executorAgent");
  return {
    agent,
    restore() {
      delete require.cache[executorAgentPath];
      if (originalExecutorClient) require.cache[executorClientPath] = originalExecutorClient;
      else delete require.cache[executorClientPath];
    },
  };
}

function buildExecutorStageOutput(title = "Stage") {
  return {
    title,
    spoken_text: `${title} spoken`,
    screen_text: `${title} screen`,
    chart_spec: {
      chart_type: "line",
      title,
      takeaway: `${title} takeaway`,
      option: { xAxis: { type: "category", data: ["Mon"] }, yAxis: { type: "value" }, series: [{ type: "line", data: [1] }] },
    },
    suggested_followups: ["Show more"],
    more_available: true,
  };
}

test("generateInitialStage normalizes executor stage output and carries response metadata", async () => {
  const { agent, restore } = loadExecutorAgentWithMock(async () => ({
    ok: true,
    status: "completed",
    responseId: "resp_stage_1",
    stageOutput: buildExecutorStageOutput("Stage 1"),
    toolEvents: [],
    outputText: JSON.stringify(buildExecutorStageOutput("Stage 1")),
  }));

  try {
    const result = await agent.generateInitialStage({
      bundle: {
        bundleId: "bundle_exec_1",
        plannerOutput: { mode: "continue_analysis" },
        metricsRequested: ["sleep_minutes"],
        normalizedTable: [{ timestamp: "2026-03-12", sleep_minutes: 430 }],
        stages: [],
      },
      question: "How did I sleep this week?",
      requestId: "req_exec_1",
    });

    assert.equal(result.ok, true);
    assert.equal(result.stage.stageIndex, 0);
    assert.equal(result.stage.title, "Stage 1");
    assert.equal(result.executorResponseId, "resp_stage_1");
    assert.equal(result.stage.metadata.executor.responseId, "resp_stage_1");
  } finally {
    restore();
  }
});

test("generateNextStage uses stored executor response id for response chaining", async () => {
  let observedPreviousResponseId = null;
  let observedStageIndex = null;
  const { agent, restore } = loadExecutorAgentWithMock(async (input) => {
    observedPreviousResponseId = input.previousResponseId;
    observedStageIndex = input.stageIndex;
    return {
      ok: true,
      status: "completed",
      responseId: "resp_stage_2",
      stageOutput: buildExecutorStageOutput("Stage 2"),
      toolEvents: [],
      outputText: JSON.stringify(buildExecutorStageOutput("Stage 2")),
    };
  });

  try {
    const result = await agent.generateNextStage({
      bundle: {
        bundleId: "bundle_exec_2",
        plannerOutput: { mode: "continue_analysis" },
        metricsRequested: ["steps"],
        normalizedTable: [{ timestamp: "2026-03-11", steps: 9000 }],
        stages: [{ stageIndex: 0, title: "Stage 1" }],
        executorResponseId: "resp_stage_1",
        currentStageIndex: 0,
      },
      question: "show more",
      requestId: "req_exec_2",
    });

    assert.equal(result.ok, true);
    assert.equal(observedPreviousResponseId, "resp_stage_1");
    assert.equal(observedStageIndex, 1);
    assert.equal(result.stage.stageIndex, 1);
    assert.equal(result.executorResponseId, "resp_stage_2");
  } finally {
    restore();
  }
});

test("generateStageFromExecutor returns a safe failure envelope when executor fails", async () => {
  const { agent, restore } = loadExecutorAgentWithMock(async () => ({
    ok: false,
    status: "timeout",
    error: "executor timeout",
    responseId: "resp_timeout",
    toolEvents: [],
  }));

  try {
    const result = await agent.generateStageFromExecutor({
      bundle: {
        bundleId: "bundle_exec_3",
        plannerOutput: {},
        metricsRequested: [],
        normalizedTable: [],
        stages: [],
      },
      question: "show more",
      stageIndex: 0,
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "timeout");
    assert.equal(result.error, "executor timeout");
    assert.equal(result.stage, null);
    assert.equal(result.executorResponseId, "resp_timeout");
  } finally {
    restore();
  }
});
