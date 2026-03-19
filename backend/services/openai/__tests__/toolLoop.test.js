const test = require("node:test");
const assert = require("node:assert/strict");

const {
  executeToolCall,
  isAllowedTool,
  isWriteTool,
  runToolLoop,
  validateToolCall,
} = require("../toolLoop");

function buildPolicy(overrides = {}) {
  return {
    allowedReadTools: ["load_bundle_snapshot", "get_normalized_bundle_data"],
    allowedWriteTools: ["mark_bundle_complete", "append_stage_note"],
    availableWriteTools: ["mark_bundle_complete", "append_stage_note", "add_bundle_note", "append_note"],
    allowedWriteSources: ["alexa", "followup", "internal"],
    writeEnabled: true,
    requireExplicitWriteAllowList: true,
    requireWriteContext: true,
    requireBundleMatch: true,
    requireUserOwnership: true,
    requireRequestOwnership: true,
    ...overrides,
  };
}

test("write-side tools are explicitly identified and policy-gated", () => {
  assert.equal(isWriteTool("mark_bundle_complete"), true);
  assert.equal(isWriteTool("load_bundle_snapshot"), false);
  assert.equal(isAllowedTool("mark_bundle_complete", buildPolicy()), true);
  assert.equal(isAllowedTool("mark_bundle_complete", buildPolicy({ allowedWriteTools: [] })), false);
  assert.equal(isAllowedTool("mark_bundle_complete", buildPolicy({ writeEnabled: false })), false);
});

test("write-side validation rejects unsafe or malformed payloads", () => {
  const invalidNote = validateToolCall("append_stage_note", { note: "" });
  assert.equal(invalidNote.ok, false);

  const invalidMetric = validateToolCall("get_normalized_bundle_data", { metric: "bad metric!", limit: 10 });
  assert.equal(invalidMetric.ok, false);

  const validMark = validateToolCall("mark_bundle_complete", { reason: "done" });
  assert.equal(validMark.ok, true);
});

test("executeToolCall blocks disallowed write calls and executes allowed ones", async () => {
  const bundle = { bundleId: "bundle_tools", username: "amy", normalizedTable: [], stages: [] };

  const denied = await executeToolCall("mark_bundle_complete", { reason: "nope" }, {
    toolContext: {
      bundle,
      username: "amy",
      bundleId: "bundle_tools",
      requestKey: "req_tools_1",
      source: "alexa",
      canWriteToBundle: () => true,
    },
    policy: buildPolicy({ allowedWriteTools: [] }),
  });
  assert.equal(denied.ok, false);
  assert.match(denied.output.error, /not allowed by policy/i);

  let markedReason = null;
  const allowed = await executeToolCall("mark_bundle_complete", { reason: "safe" }, {
    toolContext: {
      bundle,
      username: "amy",
      bundleId: "bundle_tools",
      requestKey: "req_tools_2",
      source: "alexa",
      canWriteToBundle: () => true,
      markBundleComplete: async ({ reason }) => {
        markedReason = reason;
        return { bundleId: bundle.bundleId };
      },
    },
    policy: buildPolicy(),
  });
  assert.equal(allowed.ok, true);
  assert.equal(markedReason, "safe");
  assert.equal(allowed.output.bundleId, "bundle_tools");
});

test("runToolLoop chains tool outputs into the next Responses turn", async () => {
  const requests = [];
  const runResponseRequest = async (request) => {
    requests.push(request);
    if (requests.length === 1) {
      return {
        ok: true,
        status: "incomplete",
        responseId: "resp_1",
        toolCalls: [
          {
            id: "call_1",
            name: "load_bundle_snapshot",
            arguments: "{}",
          },
        ],
      };
    }
    return {
      ok: true,
      status: "completed",
      responseId: "resp_2",
      outputJson: {
        title: "done",
      },
      toolCalls: [],
    };
  };

  const result = await runToolLoop({
    runResponseRequest,
    baseRequest: { model: "test-model", input: { q: "hello" } },
    toolContext: { bundle: { bundleId: "bundle_1", stages: [], normalizedTable: [] } },
    toolPolicy: buildPolicy(),
    maxTurns: 2,
  });

  assert.equal(result.ok, true);
  assert.equal(result.responseId, "resp_2");
  assert.equal(result.toolEvents.length, 1);
  assert.equal(result.toolEvents[0].tool, "load_bundle_snapshot");
  assert.equal(requests.length, 2);
  assert.equal(requests[1].previousResponseId, "resp_1");
  assert.ok(Array.isArray(requests[1].input));
  assert.equal(requests[1].input[0].type, "function_call_output");
});
