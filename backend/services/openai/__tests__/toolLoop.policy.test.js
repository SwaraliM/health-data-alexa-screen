const test = require("node:test");
const assert = require("node:assert/strict");

const { clearAuditRecords, getRecentAuditRecords } = require("../../qna/auditService");
const {
  canExecuteWriteTool,
  executeToolCall,
  validateWriteToolArgs,
} = require("../toolLoop");

function buildPolicy(overrides = {}) {
  return {
    allowedReadTools: ["load_bundle_snapshot"],
    allowedWriteTools: ["mark_bundle_complete", "append_stage_note", "add_bundle_note"],
    availableWriteTools: ["mark_bundle_complete", "append_stage_note", "add_bundle_note"],
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

test.beforeEach(() => {
  clearAuditRecords();
});

test("validateWriteToolArgs enforces strict write payload checks", () => {
  const invalidNote = validateWriteToolArgs("append_stage_note", { note: "" });
  assert.equal(invalidNote.ok, false);

  const invalidStage = validateWriteToolArgs("append_stage", { stage: { stageIndex: "abc" } });
  assert.equal(invalidStage.ok, false);

  const validRelease = validateWriteToolArgs("release_bundle", { reason: "done" });
  assert.equal(validRelease.ok, true);
});

test("canExecuteWriteTool denies ownership mismatches and missing context", async () => {
  const baseCtx = {
    toolContext: {
      bundle: { bundleId: "bundle_1", username: "amy" },
      username: "amy",
      bundleId: "bundle_1",
      requestKey: "req_1",
      source: "alexa",
      canWriteToBundle: () => true,
    },
  };

  const allowed = await canExecuteWriteTool({
    toolName: "mark_bundle_complete",
    args: {},
    ctx: baseCtx,
    policy: buildPolicy(),
  });
  assert.equal(allowed.allowed, true);

  const deniedRequest = await canExecuteWriteTool({
    toolName: "mark_bundle_complete",
    args: { requestKey: "wrong_req" },
    ctx: baseCtx,
    policy: buildPolicy(),
  });
  assert.equal(deniedRequest.allowed, false);
  assert.equal(deniedRequest.reason, "args_request_mismatch");

  const deniedMissingCtx = await canExecuteWriteTool({
    toolName: "mark_bundle_complete",
    args: {},
    ctx: { toolContext: { bundle: { bundleId: "bundle_1", username: "amy" } } },
    policy: buildPolicy(),
  });
  assert.equal(deniedMissingCtx.allowed, false);
  assert.equal(deniedMissingCtx.reason, "missing_write_context");
});

test("executeToolCall records audit entries for denied and allowed write attempts", async () => {
  const bundle = { bundleId: "bundle_2", username: "amy", normalizedTable: [], stages: [] };
  const baseContext = {
    bundle,
    username: "amy",
    bundleId: "bundle_2",
    requestKey: "req_2",
    source: "alexa",
    canWriteToBundle: () => true,
  };

  const denied = await executeToolCall("mark_bundle_complete", { reason: "blocked" }, {
    toolContext: {
      ...baseContext,
      canWriteToBundle: () => false,
      markBundleComplete: async () => ({ bundleId: "bundle_2" }),
    },
    policy: buildPolicy(),
  });
  assert.equal(denied.ok, false);
  assert.match(denied.output.error, /denied/i);

  const allowed = await executeToolCall("mark_bundle_complete", { reason: "safe" }, {
    toolContext: {
      ...baseContext,
      markBundleComplete: async () => ({ bundleId: "bundle_2" }),
    },
    policy: buildPolicy(),
  });
  assert.equal(allowed.ok, true);

  const audits = getRecentAuditRecords(10);
  const deniedAudit = audits.find((item) => item.toolName === "mark_bundle_complete" && item.allowed === false);
  const allowedAudit = audits.find((item) => item.toolName === "mark_bundle_complete" && item.allowed === true);

  assert.ok(deniedAudit);
  assert.ok(allowedAudit);
  assert.equal(allowedAudit.username, "amy");
  assert.equal(allowedAudit.bundleId, "bundle_2");
});
