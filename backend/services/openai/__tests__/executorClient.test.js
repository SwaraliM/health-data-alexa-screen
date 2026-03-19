const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildExecutorInput,
  runExecutorRequest,
} = require("../executorClient");

function buildConfig(overrides = {}) {
  return {
    version: "test-executor-v1",
    model: "gpt-test",
    temperature: 0.2,
    maxOutputTokens: 400,
    timeoutMs: 3600,
    maxToolTurns: 2,
    systemPrompt: "test prompt",
    textFormat: { type: "json_schema", name: "stage_output" },
    toolPolicy: {
      allowedReadTools: ["load_bundle_snapshot"],
      allowedWriteTools: ["mark_bundle_complete"],
      availableWriteTools: ["mark_bundle_complete"],
      writeEnabled: true,
      requireExplicitWriteAllowList: true,
    },
    ...overrides,
  };
}

test("buildExecutorInput keeps stage history compact and sets requested stage index", () => {
  const input = buildExecutorInput({
    stageHistory: [
      { stageIndex: 0, title: "A", spokenText: "s1", screenText: "t1", moreAvailable: true },
      { stageIndex: 1, title: "B", spokenText: "s2", screenText: "t2", moreAvailable: false },
    ],
    stageIndex: 4,
    question: "show more",
    bundleSummary: { bundleId: "bundle_1" },
  });

  assert.equal(input.requested_stage_index, 4);
  assert.equal(input.stage_history.length, 2);
  assert.equal(input.bundle_summary.bundleId, "bundle_1");
});

test("runExecutorRequest emits string-only metadata and omits toolChoice when tools unavailable", async () => {
  let observedBaseRequest = null;
  await runExecutorRequest({
    bundleSummary: { bundleId: "bundle_meta_1", username: "amy" },
    question: "show more",
    stageIndex: 2,
    __deps: {
      config: buildConfig(),
      getExecutorTools: () => [],
      runToolLoop: async ({ baseRequest }) => {
        observedBaseRequest = baseRequest;
        return {
          ok: false,
          status: "timeout",
          error: "deadline exceeded",
        };
      },
      createResponse: async () => ({ ok: true }),
    },
  });

  assert.equal(Boolean(observedBaseRequest), true);
  assert.equal(observedBaseRequest.toolChoice, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(observedBaseRequest, "tools"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(observedBaseRequest, "toolChoice"), false);
  assert.equal(typeof observedBaseRequest.metadata.stage_index, "string");
  assert.equal(observedBaseRequest.metadata.bundle_id, "bundle_meta_1");
  assert.equal(observedBaseRequest.metadata.username, "amy");
});

test("runExecutorRequest passes tool policy and returns normalized success output", async () => {
  const observed = { policy: null, baseRequest: null };
  const stageOutput = {
    title: "Sleep stage",
    spoken_text: "You slept better.",
    screen_text: "Sleep was better this week.",
    chart_spec: { chart_type: "line", title: "Sleep", takeaway: "Better", option: {} },
    suggested_followups: ["Show more detail"],
    more_available: true,
  };

  const result = await runExecutorRequest({
    bundleSummary: { bundleId: "bundle_2", username: "amy" },
    question: "show more",
    previousResponseId: "resp_prev",
    stageIndex: 2,
    __deps: {
      config: buildConfig(),
      getExecutorTools: (policy) => {
        observed.policy = policy;
        return [{ type: "function", name: "load_bundle_snapshot", parameters: { type: "object" } }];
      },
      runToolLoop: async ({ baseRequest }) => {
        observed.baseRequest = baseRequest;
        return {
          ok: true,
          status: "completed",
          responseId: "resp_new",
          outputJson: stageOutput,
          outputText: JSON.stringify(stageOutput),
          toolEvents: [{ tool: "load_bundle_snapshot", ok: true }],
          data: { id: "resp_new" },
        };
      },
      createResponse: async () => ({ ok: true }),
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.responseId, "resp_new");
  assert.equal(result.stageOutput.title, "Sleep stage");
  assert.equal(observed.baseRequest.previousResponseId, "resp_prev");
  assert.equal(observed.baseRequest.metadata.stage_index, "2");
  assert.ok(observed.policy);
});

test("runExecutorRequest returns invalid_output when structured stage JSON is missing", async () => {
  const result = await runExecutorRequest({
    question: "show more",
    __deps: {
      config: buildConfig(),
      getExecutorTools: () => [],
      runToolLoop: async () => ({
        ok: true,
        status: "completed",
        responseId: "resp_bad",
        outputJson: null,
        outputText: "not-json-output",
      }),
      createResponse: async () => ({ ok: true }),
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "invalid_output");
  assert.match(result.error, /valid structured json/i);
});

test("runExecutorRequest propagates timeout/error responses", async () => {
  const result = await runExecutorRequest({
    question: "show more",
    __deps: {
      config: buildConfig(),
      getExecutorTools: () => [],
      runToolLoop: async () => ({
        ok: false,
        status: "timeout",
        error: "deadline exceeded",
      }),
      createResponse: async () => ({ ok: true }),
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "timeout");
  assert.equal(result.error, "deadline exceeded");
});

test("runExecutorRequest retries once without previousResponseId on HTTP 400", async () => {
  const calls = [];
  const result = await runExecutorRequest({
    bundleSummary: { bundleId: "bundle_retry_1", username: "amy" },
    question: "show more",
    previousResponseId: "resp_stale",
    stageIndex: 1,
    __deps: {
      config: buildConfig(),
      getExecutorTools: () => [],
      runToolLoop: async ({ baseRequest }) => {
        calls.push(baseRequest.previousResponseId || null);
        if (calls.length === 1) {
          return {
            ok: false,
            status: "http_error",
            error: "HTTP 400",
            responseId: null,
          };
        }
        return {
          ok: true,
          status: "completed",
          responseId: "resp_retry_ok",
          outputJson: {
            title: "Retry stage",
            spoken_text: "Retry worked.",
            screen_text: "Retry worked.",
            chart_spec: { chart_type: "line", title: "Retry", takeaway: "Retry", option: {} },
            suggested_followups: ["show more"],
            more_available: true,
          },
          outputText: "",
          toolEvents: [],
          data: { id: "resp_retry_ok" },
        };
      },
      createResponse: async () => ({ ok: true }),
    },
  });

  assert.deepEqual(calls, ["resp_stale", null]);
  assert.equal(result.ok, true);
  assert.equal(result.responseId, "resp_retry_ok");
});
