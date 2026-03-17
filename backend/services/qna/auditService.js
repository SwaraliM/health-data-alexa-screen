/**
 * backend/services/qna/auditService.js
 *
 * Phase 7 lightweight audit trail helpers.
 * Scope:
 * - keep write-tool and stale-request audit records structured
 * - keep implementation in-memory and low-latency for prototype usage
 * - avoid introducing heavyweight auth/audit infrastructure in this phase
 */

const { AGENT_CONFIGS } = require("../../configs/agentConfigs");

const AUDIT_DEBUG = process.env.QNA_AUDIT_DEBUG !== "false";
const AUDIT_ENABLED = AGENT_CONFIGS?.executor?.audit?.enabled !== false;
const AUDIT_MAX_RECORDS = Math.max(
  50,
  Number(AGENT_CONFIGS?.executor?.audit?.maxInMemoryRecords || 400)
);

const auditRecords = [];

function auditLog(message, data = null) {
  if (!AUDIT_DEBUG) return;
  if (data == null) return console.log(`[AuditService] ${message}`);
  console.log(`[AuditService] ${message}`, data);
}

function sanitizeText(value, max = 180, fallback = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : fallback;
}

function summarizeArgs(args = null) {
  const source = args && typeof args === "object" ? args : {};
  const out = {};
  Object.keys(source)
    .slice(0, 10)
    .forEach((key) => {
      const value = source[key];
      if (value == null) {
        out[key] = null;
        return;
      }
      if (typeof value === "string") {
        out[key] = sanitizeText(value, 120, "");
        return;
      }
      if (typeof value === "number" || typeof value === "boolean") {
        out[key] = value;
        return;
      }
      if (Array.isArray(value)) {
        out[key] = value.slice(0, 5).map((item) => {
          if (item == null) return null;
          if (typeof item === "string") return sanitizeText(item, 80, "");
          if (typeof item === "number" || typeof item === "boolean") return item;
          return "[object]";
        });
        return;
      }
      out[key] = "[object]";
    });
  return out;
}

function pushAuditRecord(entry = null) {
  if (!AUDIT_ENABLED) return null;
  const record = entry && typeof entry === "object" ? { ...entry } : null;
  if (!record) return null;
  auditRecords.push(record);
  if (auditRecords.length > AUDIT_MAX_RECORDS) {
    auditRecords.splice(0, auditRecords.length - AUDIT_MAX_RECORDS);
  }
  return record;
}

function buildCommonAuditContext({
  username = null,
  bundleId = null,
  requestKey = null,
  source = null,
} = {}) {
  return {
    username: sanitizeText(username, 80, "") || null,
    bundleId: sanitizeText(bundleId, 120, "") || null,
    requestKey: sanitizeText(requestKey, 140, "") || null,
    source: sanitizeText(source, 40, "internal") || "internal",
  };
}

function recordToolAudit({
  username = null,
  bundleId = null,
  requestKey = null,
  source = null,
  toolName = null,
  args = null,
  allowed = false,
  result = null,
  reason = null,
  eventType = "tool_write_attempt",
} = {}) {
  const context = buildCommonAuditContext({
    username,
    bundleId,
    requestKey,
    source,
  });
  const record = pushAuditRecord({
    eventType,
    ...context,
    toolName: sanitizeText(toolName, 80, "") || null,
    argsSummary: summarizeArgs(args),
    allowed: Boolean(allowed),
    result: sanitizeText(result, 220, "") || null,
    reason: sanitizeText(reason, 180, "") || null,
    timestamp: new Date().toISOString(),
  });
  if (record) {
    auditLog("tool audit recorded", {
      eventType: record.eventType,
      toolName: record.toolName,
      allowed: record.allowed,
      username: record.username,
      bundleId: record.bundleId,
      reason: record.reason,
    });
  }
  return record;
}

function recordSessionAudit({
  eventType = "session_event",
  username = null,
  bundleId = null,
  requestKey = null,
  source = null,
  result = null,
  reason = null,
  extra = null,
} = {}) {
  const context = buildCommonAuditContext({
    username,
    bundleId,
    requestKey,
    source,
  });
  const record = pushAuditRecord({
    eventType: sanitizeText(eventType, 80, "session_event"),
    ...context,
    allowed: null,
    result: sanitizeText(result, 220, "") || null,
    reason: sanitizeText(reason, 180, "") || null,
    extra: extra && typeof extra === "object" ? extra : null,
    timestamp: new Date().toISOString(),
  });
  if (record) {
    auditLog("session audit recorded", {
      eventType: record.eventType,
      username: record.username,
      bundleId: record.bundleId,
      reason: record.reason,
    });
  }
  return record;
}

function getRecentAuditRecords(limit = 50) {
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 50));
  return auditRecords.slice(-safeLimit);
}

function clearAuditRecords() {
  auditRecords.splice(0, auditRecords.length);
}

module.exports = {
  AUDIT_ENABLED,
  clearAuditRecords,
  getRecentAuditRecords,
  recordSessionAudit,
  recordToolAudit,
  summarizeArgs,
};
