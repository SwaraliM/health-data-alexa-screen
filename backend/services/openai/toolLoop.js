/**
 * backend/services/openai/toolLoop.js
 *
 * Phase 7 lightweight tool loop with explicit write-policy + audit guardrails.
 * Scope:
 * - keep read tools simple and deterministic
 * - allow tightly controlled write tools with strict validation and ownership checks
 * - preserve bounded multi-turn behavior for Alexa latency compatibility
 */

const { recordToolAudit } = require("../qna/auditService");

const TOOL_LOOP_DEBUG = process.env.OPENAI_TOOL_LOOP_DEBUG !== "false";
const MAX_TOOL_CALLS_PER_TURN = 3;
const METRIC_KEY_RE = /^[a-z0-9_]{1,64}$/i;
const WRITE_TOOL_DEFAULT_SOURCES = ["alexa", "web", "followup", "internal"];

function loopLog(message, data = null) {
  if (!TOOL_LOOP_DEBUG) return;
  if (data == null) return console.log(`[ToolLoop] ${message}`);
  console.log(`[ToolLoop] ${message}`, data);
}

function sanitizeText(value, max = 120, fallback = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : fallback;
}

function safeJsonParse(value) {
  if (value == null) return {};
  if (typeof value === "object") return value;
  if (typeof value !== "string") return {};
  try {
    return JSON.parse(value);
  } catch (_) {
    return {};
  }
}

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const READ_TOOL_DEFS = [
  {
    type: "function",
    name: "load_bundle",
    description: "Load lightweight bundle metadata and stage summary.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    type: "function",
    name: "load_bundle_snapshot",
    description: "Load lightweight bundle metadata and stage summary.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    type: "function",
    name: "get_stage_history",
    description: "Read compact prior stage history from the active bundle.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: {
          type: "number",
          description: "Max stages to return (default 6, max 12).",
        },
      },
    },
  },
  {
    type: "function",
    name: "get_normalized_table",
    description: "Read normalized Fitbit rows from the active bundle.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        metric: {
          type: "string",
          description: "Optional metric column name from normalized table.",
        },
        limit: {
          type: "number",
          description: "Max rows to return (default 60, max 180).",
        },
      },
    },
  },
  {
    type: "function",
    name: "get_normalized_bundle_data",
    description: "Read normalized Fitbit rows from the active bundle.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        metric: {
          type: "string",
          description: "Optional metric column name from normalized table.",
        },
        limit: {
          type: "number",
          description: "Max rows to return (default 60, max 180).",
        },
      },
    },
  },
  {
    type: "function",
    name: "get_user_context",
    description: "Read non-sensitive user context passed into executor.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    type: "function",
    name: "fetch_additional_fitbit_data",
    description: "Request additional read-only Fitbit rows through guarded backend callback.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        metrics: {
          type: "array",
          items: { type: "string" },
          description: "Metric keys to request.",
        },
        limit: {
          type: "number",
          description: "Max rows per metric (default 60, max 180).",
        },
      },
    },
  },
];

const WRITE_TOOL_DEFS = [
  {
    type: "function",
    name: "mark_bundle_complete",
    description: "Mark the current bundle complete when no more stages are needed.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        reason: { type: "string" },
      },
    },
  },
  {
    type: "function",
    name: "append_note",
    description: "Alias for append_stage_note.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        note: { type: "string" },
      },
      required: ["note"],
    },
  },
  {
    type: "function",
    name: "append_stage_note",
    description: "Append a short validated note to bundle metadata.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        note: { type: "string" },
      },
      required: ["note"],
    },
  },
  // Alias retained for backward compatibility in model prompts.
  {
    type: "function",
    name: "add_bundle_note",
    description: "Alias for append_stage_note.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        note: { type: "string" },
      },
      required: ["note"],
    },
  },
  {
    type: "function",
    name: "append_stage",
    description: "Append a fully validated stage object to the bundle.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        stage: { type: "object" },
      },
      required: ["stage"],
    },
  },
  {
    type: "function",
    name: "release_bundle",
    description: "Release the current bundle for lifecycle transitions.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        reason: { type: "string" },
      },
    },
  },
];

const ALL_TOOL_DEFS = [...READ_TOOL_DEFS, ...WRITE_TOOL_DEFS];
const WRITE_TOOL_NAMES = new Set(WRITE_TOOL_DEFS.map((tool) => tool.name.toLowerCase()));

function normalizeList(values = []) {
  if (!Array.isArray(values)) return [];
  return values
    .map((item) => String(item || "").trim().toLowerCase())
    .filter(Boolean);
}

function normalizeToolPolicy(policy = null) {
  const source = policy && typeof policy === "object" ? policy : {};
  const allowedReadTools = normalizeList(source.allowedReadTools);
  const allowedWriteTools = normalizeList(source.allowedWriteTools);
  const availableWriteTools = normalizeList(source.availableWriteTools);
  const allowedWriteSources = normalizeList(source.allowedWriteSources);
  return {
    allowedReadTools: allowedReadTools.length
      ? allowedReadTools
      : READ_TOOL_DEFS.map((tool) => tool.name.toLowerCase()),
    allowedWriteTools,
    availableWriteTools: availableWriteTools.length
      ? availableWriteTools
      : WRITE_TOOL_DEFS.map((tool) => tool.name.toLowerCase()),
    allowedWriteSources: allowedWriteSources.length
      ? allowedWriteSources
      : WRITE_TOOL_DEFAULT_SOURCES.slice(),
    writeEnabled: source.writeEnabled !== false,
    requireExplicitWriteAllowList: source.requireExplicitWriteAllowList !== false,
    requireWriteContext: source.requireWriteContext !== false,
    requireBundleMatch: source.requireBundleMatch !== false,
    requireUserOwnership: source.requireUserOwnership !== false,
    requireRequestOwnership: source.requireRequestOwnership !== false,
  };
}

function isWriteTool(toolName = "") {
  return WRITE_TOOL_NAMES.has(String(toolName || "").trim().toLowerCase());
}

function isReadTool(toolName = "") {
  const name = String(toolName || "").trim().toLowerCase();
  return READ_TOOL_DEFS.some((tool) => tool.name.toLowerCase() === name);
}

function resolveWriteContext(toolContext = {}) {
  const bundle = toolContext?.bundle || null;
  return {
    username: sanitizeText(
      toolContext?.username || toolContext?.userName || bundle?.username || "",
      80,
      ""
    ).toLowerCase(),
    bundleId: sanitizeText(toolContext?.bundleId || bundle?.bundleId || "", 120, ""),
    requestKey: sanitizeText(
      toolContext?.requestKey || toolContext?.requestId || "",
      140,
      ""
    ),
    source: sanitizeText(toolContext?.source || "internal", 40, "internal").toLowerCase(),
  };
}

async function canExecuteWriteTool({
  toolName,
  args = {},
  ctx = {},
  policy = null,
} = {}) {
  const name = String(toolName || "").trim().toLowerCase();
  const toolContext = ctx?.toolContext || {};
  const writeCtx = resolveWriteContext(toolContext);
  const normalizedPolicy = normalizeToolPolicy(policy);
  const sourceArgs = args && typeof args === "object" ? args : {};

  if (!isWriteTool(name)) {
    return { allowed: true, reason: "not_write_tool", writeCtx };
  }
  if (!isAllowedTool(name, normalizedPolicy)) {
    return { allowed: false, reason: "tool_not_allowed_by_policy", writeCtx };
  }
  if (normalizedPolicy.requireWriteContext) {
    if (!writeCtx.username || !writeCtx.bundleId || !writeCtx.requestKey) {
      return { allowed: false, reason: "missing_write_context", writeCtx };
    }
  }
  if (normalizedPolicy.allowedWriteSources.length) {
    if (!normalizedPolicy.allowedWriteSources.includes(writeCtx.source)) {
      return { allowed: false, reason: "write_source_not_allowed", writeCtx };
    }
  }

  const bundle = toolContext?.bundle || null;
  if (normalizedPolicy.requireBundleMatch && bundle?.bundleId) {
    if (writeCtx.bundleId !== String(bundle.bundleId)) {
      return { allowed: false, reason: "bundle_context_mismatch", writeCtx };
    }
  }
  if (normalizedPolicy.requireUserOwnership && bundle?.username) {
    if (writeCtx.username !== String(bundle.username || "").toLowerCase()) {
      return { allowed: false, reason: "username_context_mismatch", writeCtx };
    }
  }

  if (sourceArgs.bundleId != null && sourceArgs.bundleId !== "") {
    if (String(sourceArgs.bundleId) !== writeCtx.bundleId) {
      return { allowed: false, reason: "args_bundle_mismatch", writeCtx };
    }
  }
  if (sourceArgs.username != null && sourceArgs.username !== "") {
    if (String(sourceArgs.username).trim().toLowerCase() !== writeCtx.username) {
      return { allowed: false, reason: "args_username_mismatch", writeCtx };
    }
  }
  if (sourceArgs.requestKey != null && sourceArgs.requestKey !== "") {
    if (String(sourceArgs.requestKey).trim() !== writeCtx.requestKey) {
      return { allowed: false, reason: "args_request_mismatch", writeCtx };
    }
  }

  if (normalizedPolicy.requireRequestOwnership) {
    if (typeof toolContext?.canWriteToBundle === "function") {
      const owned = await Promise.resolve(toolContext.canWriteToBundle({
        username: writeCtx.username,
        bundleId: writeCtx.bundleId,
        requestKey: writeCtx.requestKey,
        toolName: name,
      }));
      if (!owned) return { allowed: false, reason: "request_ownership_rejected", writeCtx };
    }
  }

  return { allowed: true, reason: "write_policy_allowed", writeCtx };
}

function auditToolCall({
  toolName,
  args = {},
  ctx = {},
  result = null,
  allowed = false,
  reason = null,
} = {}) {
  const toolContext = ctx?.toolContext || {};
  const writeCtx = resolveWriteContext(toolContext);
  if (!isWriteTool(toolName)) return null;
  return recordToolAudit({
    username: writeCtx.username || null,
    bundleId: writeCtx.bundleId || null,
    requestKey: writeCtx.requestKey || null,
    source: writeCtx.source || "internal",
    toolName,
    args,
    allowed,
    result: result && typeof result === "object"
      ? (result.ok ? "ok" : (result?.output?.error || "error"))
      : (result || null),
    reason,
    eventType: allowed ? "tool_write_allowed" : "tool_write_denied",
  });
}

function isAllowedTool(toolName = "", policy = null) {
  const name = String(toolName || "").trim().toLowerCase();
  const normalizedPolicy = normalizeToolPolicy(policy);
  if (!name) return false;

  if (isWriteTool(name)) {
    if (!normalizedPolicy.writeEnabled) return false;
    if (!normalizedPolicy.availableWriteTools.includes(name)) return false;
    if (!normalizedPolicy.requireExplicitWriteAllowList) return true;
    return normalizedPolicy.allowedWriteTools.includes(name);
  }
  return normalizedPolicy.allowedReadTools.includes(name);
}

function getExecutorTools(policy = null) {
  const normalizedPolicy = normalizeToolPolicy(policy);
  return ALL_TOOL_DEFS.filter((tool) => isAllowedTool(tool.name.toLowerCase(), normalizedPolicy));
}

function getToolName(call = {}) {
  return String(
    call?.name
    || call?.function?.name
    || call?.tool_name
    || ""
  ).trim();
}

function getToolCallId(call = {}) {
  return String(call?.call_id || call?.id || "").trim() || null;
}

function getToolArgs(call = {}) {
  return safeJsonParse(call?.arguments || call?.input || call?.function?.arguments || {});
}

function validateNoArgs(args = {}) {
  const source = args && typeof args === "object" ? args : {};
  const keys = Object.keys(source);
  if (keys.length) return { ok: false, error: "This tool does not accept arguments." };
  return { ok: true, value: {} };
}

function validateWriteToolArgs(toolName = "", args = {}) {
  const name = String(toolName || "").trim().toLowerCase();
  const source = args && typeof args === "object" ? args : {};

  if (name === "mark_bundle_complete") {
    return {
      ok: true,
      value: {
        reason: sanitizeText(source.reason, 140, "executor_tool_mark_complete"),
      },
    };
  }

  if (name === "append_note" || name === "append_stage_note" || name === "add_bundle_note") {
    const note = sanitizeText(source.note, 220, "");
    if (!note) return { ok: false, error: "note is required." };
    return { ok: true, value: { note } };
  }

  if (name === "append_stage") {
    const stage = source.stage;
    if (!stage || typeof stage !== "object" || Array.isArray(stage)) {
      return { ok: false, error: "stage must be a plain object." };
    }
    const stageIndex = stage.stageIndex == null ? null : Number(stage.stageIndex);
    if (stageIndex != null && !Number.isFinite(stageIndex)) {
      return { ok: false, error: "stage.stageIndex must be numeric when provided." };
    }
    return {
      ok: true,
      value: {
        stage: {
          ...stage,
          ...(stageIndex != null ? { stageIndex: Math.max(0, Math.floor(stageIndex)) } : {}),
        },
      },
    };
  }

  if (name === "release_bundle") {
    return {
      ok: true,
      value: {
        reason: sanitizeText(source.reason, 140, "executor_tool_release_bundle"),
      },
    };
  }

  return { ok: false, error: `Unsupported write tool: ${name}` };
}

function validateToolCall(toolName = "", args = {}) {
  const name = String(toolName || "").trim().toLowerCase();
  const source = args && typeof args === "object" ? args : {};

  if (!name) return { ok: false, error: "Tool name is required." };

  if (isWriteTool(name)) {
    return validateWriteToolArgs(name, source);
  }

  if (name === "load_bundle" || name === "load_bundle_snapshot" || name === "get_user_context") {
    return validateNoArgs(source);
  }

  if (name === "get_stage_history") {
    const requestedLimit = asNumber(source.limit, 6);
    const safeLimit = Math.min(12, Math.max(1, Math.floor(requestedLimit)));
    return {
      ok: true,
      value: {
        limit: safeLimit,
      },
    };
  }

  if (name === "get_normalized_table" || name === "get_normalized_bundle_data") {
    const metricRaw = source.metric == null ? "" : String(source.metric).trim();
    if (metricRaw && !METRIC_KEY_RE.test(metricRaw)) {
      return { ok: false, error: "metric must be an alphanumeric metric key." };
    }
    const requestedLimit = asNumber(source.limit, 60);
    const safeLimit = Math.min(180, Math.max(1, Math.floor(requestedLimit)));
    return {
      ok: true,
      value: {
        metric: metricRaw || null,
        limit: safeLimit,
      },
    };
  }

  if (name === "fetch_additional_fitbit_data") {
    const rawMetrics = Array.isArray(source.metrics) ? source.metrics : [];
    const metrics = rawMetrics
      .map((item) => String(item || "").trim().toLowerCase())
      .filter((item) => item && METRIC_KEY_RE.test(item))
      .slice(0, 4);
    if (!metrics.length) {
      return { ok: false, error: "metrics must contain at least one metric key." };
    }
    const requestedLimit = asNumber(source.limit, 60);
    return {
      ok: true,
      value: {
        metrics,
        limit: Math.min(180, Math.max(1, Math.floor(requestedLimit))),
      },
    };
  }

  return { ok: false, error: `Unsupported tool: ${name}` };
}

async function executeToolCall(toolName = "", args = {}, ctx = {}) {
  const name = String(toolName || "").trim().toLowerCase();
  const toolContext = ctx?.toolContext || {};
  const policy = ctx?.policy || null;

  if (!name) {
    return {
      ok: false,
      tool: "unknown",
      output: { error: "Tool name missing." },
    };
  }

  const isWriteAttempt = isWriteTool(name);
  const allowed = isAllowedTool(name, policy);
  if (isWriteAttempt) {
    loopLog("write-side tool attempt", {
      tool: name,
      allowed,
      bundleId: toolContext?.bundle?.bundleId || null,
      requestKey: toolContext?.requestKey || null,
      source: toolContext?.source || "internal",
    });
  }
  if (!allowed) {
    const denied = {
      ok: false,
      tool: name,
      output: { error: `Tool not allowed by policy: ${name}` },
    };
    auditToolCall({
      toolName: name,
      args,
      ctx,
      result: denied,
      allowed: false,
      reason: "policy_not_allowed",
    });
    return denied;
  }

  const validation = validateToolCall(name, args);
  if (!validation.ok) {
    const denied = {
      ok: false,
      tool: name,
      output: { error: validation.error || "Tool arguments are invalid." },
    };
    auditToolCall({
      toolName: name,
      args,
      ctx,
      result: denied,
      allowed: false,
      reason: "validation_failed",
    });
    return denied;
  }

  if (isWriteAttempt) {
    const writeGuard = await canExecuteWriteTool({
      toolName: name,
      args: validation.value || {},
      ctx: { toolContext },
      policy,
    });
    if (!writeGuard.allowed) {
      const denied = {
        ok: false,
        tool: name,
        output: { error: `Write tool denied: ${writeGuard.reason}` },
      };
      loopLog("write-side tool denied", {
        tool: name,
        reason: writeGuard.reason,
        username: writeGuard.writeCtx?.username || null,
        bundleId: writeGuard.writeCtx?.bundleId || null,
        requestKey: writeGuard.writeCtx?.requestKey || null,
      });
      auditToolCall({
        toolName: name,
        args: validation.value || {},
        ctx,
        result: denied,
        allowed: false,
        reason: writeGuard.reason,
      });
      return denied;
    }
  }

  const safeArgs = validation.value || {};
  const bundle = toolContext?.bundle || null;
  const normalizedRows = Array.isArray(bundle?.normalizedTable) ? bundle.normalizedTable : [];
  const stageList = Array.isArray(bundle?.stages) ? bundle.stages : [];
  const userContext = toolContext?.userContext || null;

  if (name === "load_bundle" || name === "load_bundle_snapshot") {
    return {
      ok: true,
      tool: name,
      output: {
        bundleId: bundle?.bundleId || null,
        status: bundle?.status || null,
        question: bundle?.question || "",
        metricsRequested: Array.isArray(bundle?.metricsRequested) ? bundle.metricsRequested.slice(0, 8) : [],
        currentStageIndex: Number(bundle?.currentStageIndex || 0),
        stageCount: stageList.length,
        parentBundleId: bundle?.parentBundleId || null,
        executorResponseId: bundle?.executorResponseId || null,
      },
    };
  }

  if (name === "get_stage_history") {
    const limit = Math.min(12, Math.max(1, Number(safeArgs.limit) || 6));
    const rows = stageList
      .slice()
      .sort((a, b) => Number(a?.stageIndex || 0) - Number(b?.stageIndex || 0))
      .slice(-limit)
      .map((stage) => ({
        stageIndex: Number(stage?.stageIndex || 0),
        title: sanitizeText(stage?.title, 120, ""),
        spokenText: sanitizeText(stage?.spokenText, 260, ""),
        screenText: sanitizeText(stage?.screenText, 260, ""),
        moreAvailable: Boolean(stage?.moreAvailable),
        source: sanitizeText(stage?.source, 60, ""),
      }));
    return {
      ok: true,
      tool: name,
      output: {
        stageCount: stageList.length,
        history: rows,
      },
    };
  }

  if (name === "get_user_context") {
    return {
      ok: true,
      tool: name,
      output: {
        userContext: userContext || null,
        username: bundle?.username || null,
        bundleId: bundle?.bundleId || null,
      },
    };
  }

  if (name === "get_normalized_table" || name === "get_normalized_bundle_data") {
    const metric = safeArgs.metric || "";
    const limit = Math.min(180, Math.max(1, Number(safeArgs.limit) || 60));

    const rows = metric
      ? normalizedRows
          .filter((row) => row && Object.prototype.hasOwnProperty.call(row, metric))
          .map((row) => ({
            timestamp: row.timestamp || null,
            [metric]: row[metric] == null ? null : row[metric],
          }))
      : normalizedRows;

    return {
      ok: true,
      tool: name,
      output: {
        metric: metric || null,
        rowCount: rows.length,
        rows: rows.slice(-limit),
      },
    };
  }

  if (name === "fetch_additional_fitbit_data") {
    if (typeof toolContext?.fetchAdditionalFitbitData !== "function") {
      return {
        ok: false,
        tool: name,
        output: { error: "fetchAdditionalFitbitData callback unavailable" },
      };
    }
    const fetched = await toolContext.fetchAdditionalFitbitData({
      metrics: safeArgs.metrics || [],
      limit: safeArgs.limit || 60,
    });
    return {
      ok: true,
      tool: name,
      output: fetched && typeof fetched === "object"
        ? fetched
        : { fetched: false, reason: "empty_fetch_result" },
    };
  }

  if (name === "mark_bundle_complete") {
    if (typeof toolContext?.markBundleComplete !== "function") {
      const denied = {
        ok: false,
        tool: name,
        output: { error: "markBundleComplete callback unavailable" },
      };
      auditToolCall({
        toolName: name,
        args: safeArgs,
        ctx,
        result: denied,
        allowed: false,
        reason: "missing_write_callback",
      });
      return denied;
    }
    const result = await toolContext.markBundleComplete({ reason: safeArgs.reason });
    const allowedResult = {
      ok: true,
      tool: name,
      output: {
        bundleId: result?.bundleId || bundle?.bundleId || null,
        marked: true,
        reason: safeArgs.reason,
      },
    };
    auditToolCall({
      toolName: name,
      args: safeArgs,
      ctx,
      result: allowedResult,
      allowed: true,
      reason: "write_executed",
    });
    return allowedResult;
  }

  if (name === "append_note" || name === "append_stage_note" || name === "add_bundle_note") {
    if (typeof toolContext?.appendStageNote !== "function") {
      const denied = {
        ok: false,
        tool: name,
        output: { error: "appendStageNote callback unavailable" },
      };
      auditToolCall({
        toolName: name,
        args: safeArgs,
        ctx,
        result: denied,
        allowed: false,
        reason: "missing_write_callback",
      });
      return denied;
    }
    const result = await toolContext.appendStageNote({ note: safeArgs.note });
    const allowedResult = {
      ok: true,
      tool: name,
      output: {
        note: safeArgs.note,
        updated: Boolean(result),
      },
    };
    auditToolCall({
      toolName: name,
      args: safeArgs,
      ctx,
      result: allowedResult,
      allowed: true,
      reason: "write_executed",
    });
    return allowedResult;
  }

  if (name === "append_stage") {
    if (typeof toolContext?.appendStage !== "function") {
      const denied = {
        ok: false,
        tool: name,
        output: { error: "appendStage callback unavailable" },
      };
      auditToolCall({
        toolName: name,
        args: safeArgs,
        ctx,
        result: denied,
        allowed: false,
        reason: "missing_write_callback",
      });
      return denied;
    }
    const result = await toolContext.appendStage({ stage: safeArgs.stage });
    const allowedResult = {
      ok: true,
      tool: name,
      output: {
        updated: Boolean(result),
      },
    };
    auditToolCall({
      toolName: name,
      args: safeArgs,
      ctx,
      result: allowedResult,
      allowed: true,
      reason: "write_executed",
    });
    return allowedResult;
  }

  if (name === "release_bundle") {
    if (typeof toolContext?.releaseBundle !== "function") {
      const denied = {
        ok: false,
        tool: name,
        output: { error: "releaseBundle callback unavailable" },
      };
      auditToolCall({
        toolName: name,
        args: safeArgs,
        ctx,
        result: denied,
        allowed: false,
        reason: "missing_write_callback",
      });
      return denied;
    }
    const result = await toolContext.releaseBundle({ reason: safeArgs.reason });
    const allowedResult = {
      ok: true,
      tool: name,
      output: {
        released: Boolean(result),
        reason: safeArgs.reason,
      },
    };
    auditToolCall({
      toolName: name,
      args: safeArgs,
      ctx,
      result: allowedResult,
      allowed: true,
      reason: "write_executed",
    });
    return allowedResult;
  }

  return {
    ok: false,
    tool: name || "unknown",
    output: { error: `Unsupported tool: ${name || "unknown"}` },
  };
}

async function handleToolCall(call = {}, ctx = {}) {
  const toolName = getToolName(call);
  const args = getToolArgs(call);
  const toolContext = ctx?.toolContext || ctx || {};
  const policy = ctx?.policy || ctx?.toolPolicy || null;
  return executeToolCall(toolName, args, {
    toolContext,
    policy,
  });
}

function toFunctionCallOutputs(toolCalls = [], toolOutputs = []) {
  const out = [];
  toolOutputs.forEach((result, idx) => {
    const call = toolCalls[idx] || {};
    const callId = getToolCallId(call);
    if (!callId) return;
    out.push({
      type: "function_call_output",
      call_id: callId,
      output: JSON.stringify(result?.output || {}),
    });
  });
  return out;
}

/**
 * runToolLoop executes at most a few turns:
 * 1) model response
 * 2) optional tool execution
 * 3) model continuation with tool outputs
 */
async function runToolLoop({
  runResponseRequest,
  baseRequest = {},
  toolContext = {},
  toolPolicy = null,
  maxTurns = 2,
} = {}) {
  if (typeof runResponseRequest !== "function") {
    throw new Error("runToolLoop requires runResponseRequest");
  }

  let turn = 0;
  let latest = null;
  let request = { ...baseRequest };
  const toolEvents = [];

  while (turn < Math.max(1, maxTurns)) {
    turn += 1;
    latest = await runResponseRequest(request);
    if (!latest?.ok) {
      return {
        ...latest,
        toolEvents,
      };
    }

    const toolCalls = Array.isArray(latest.toolCalls) ? latest.toolCalls.slice(0, MAX_TOOL_CALLS_PER_TURN) : [];
    if (!toolCalls.length) break;

    loopLog("executor requested tools", {
      turn,
      toolCount: toolCalls.length,
      toolNames: toolCalls.map((call) => getToolName(call)),
    });

    const toolOutputs = [];
    for (const call of toolCalls) {
      // Sequential execution keeps write ordering predictable.
      const result = await handleToolCall(call, {
        toolContext,
        policy: toolPolicy,
      });
      const toolName = result?.tool || getToolName(call);
      const isWrite = isWriteTool(toolName);
      loopLog("tool call executed", {
        turn,
        tool: toolName,
        ok: Boolean(result?.ok),
        write: isWrite,
      });
      toolOutputs.push(result);
      toolEvents.push({
        turn,
        tool: toolName,
        ok: Boolean(result?.ok),
        write: isWrite,
      });
    }

    const functionOutputs = toFunctionCallOutputs(toolCalls, toolOutputs);
    if (!functionOutputs.length) break;

    request = {
      ...baseRequest,
      input: functionOutputs,
      previousResponseId: latest.responseId || request.previousResponseId || null,
    };
  }

  return {
    ...latest,
    toolEvents,
  };
}

module.exports = {
  auditToolCall,
  canExecuteWriteTool,
  executeToolCall,
  getExecutorTools,
  getToolArgs,
  getToolName,
  isAllowedTool,
  isReadTool,
  isWriteTool,
  runToolLoop,
  validateToolCall,
  validateWriteToolArgs,
};
