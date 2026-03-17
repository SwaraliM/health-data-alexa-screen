/**
 * backend/services/openai/responsesClient.js
 *
 * Phase 2 generic OpenAI Responses API wrapper for the new agentic path.
 *
 * Legacy note:
 * - Existing runtime QnA still uses `services/openAIClient.js` (chat/completions).
 * - This client is additive and used by planner shadow-mode scaffolding.
 */

require("dotenv").config();

const RESPONSES_URL = "https://api.openai.com/v1/responses";
const RESPONSES_DEBUG = process.env.OPENAI_RESPONSES_DEBUG !== "false";

function responsesLog(message, data = null) {
  if (!RESPONSES_DEBUG) return;
  if (data == null) return console.log(`[ResponsesClient] ${message}`);
  console.log(`[ResponsesClient] ${message}`, data);
}

function safeJsonParse(text) {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function extractApiErrorMessage(errorBody = "") {
  const parsed = safeJsonParse(errorBody);
  if (!parsed || typeof parsed !== "object") return "";
  const fromErrorObject = typeof parsed?.error?.message === "string"
    ? parsed.error.message.trim()
    : "";
  if (fromErrorObject) return fromErrorObject;
  const fromMessage = typeof parsed?.message === "string" ? parsed.message.trim() : "";
  if (fromMessage) return fromMessage;
  return "";
}

function compactText(value, max = 260) {
  const source = typeof value === "string"
    ? value
    : value == null
      ? ""
      : JSON.stringify(value);
  return String(source || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function emitTrace(onTrace, trace) {
  if (typeof onTrace !== "function") return;
  try {
    onTrace(trace);
  } catch (_) {
    // Traces must never break runtime behavior.
  }
}

function asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeInput(input) {
  if (input == null) return "";
  if (typeof input === "string") return input;
  if (Array.isArray(input)) return input;
  if (typeof input === "object") return JSON.stringify(input);
  return String(input);
}

/**
 * Responses API can return text in slightly different shapes depending on model/features.
 */
function extractOutputText(responseData = {}) {
  if (typeof responseData?.output_text === "string" && responseData.output_text.trim()) {
    return responseData.output_text.trim();
  }

  const chunks = [];
  const output = Array.isArray(responseData?.output) ? responseData.output : [];
  output.forEach((item) => {
    const content = Array.isArray(item?.content) ? item.content : [];
    content.forEach((part) => {
      if (typeof part?.text === "string" && part.text.trim()) chunks.push(part.text.trim());
      if (typeof part?.output_text === "string" && part.output_text.trim()) chunks.push(part.output_text.trim());
    });
  });

  return chunks.join("\n").trim();
}

function extractToolCalls(responseData = {}) {
  const calls = [];
  const output = Array.isArray(responseData?.output) ? responseData.output : [];
  output.forEach((item) => {
    if (!item || typeof item !== "object") return;
    if (item.type === "tool_call" || item.type === "function_call") calls.push(item);
  });
  return calls;
}

/**
 * Generic create response helper for the new architecture.
 */
async function createResponse({
  model = process.env.OPENAI_QNA_MODEL || "gpt-4o-mini",
  input,
  instructions = "",
  responseFormat = null,
  previousResponseId = null,
  tools = null,
  toolChoice = null,
  timeoutMs = null,
  temperature = null,
  maxOutputTokens = null,
  metadata = null,
  onTrace = null,
} = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const errorMessage = "OPENAI_API_KEY missing";
    responsesLog(errorMessage);
    emitTrace(onTrace, {
      status: "skipped",
      request_summary: compactText({ model, input }),
      response_summary: "",
      error_message: errorMessage,
    });
    return {
      ok: false,
      status: "skipped",
      error: errorMessage,
      responseId: null,
      outputText: "",
      outputJson: null,
      toolCalls: [],
      data: null,
    };
  }

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timeoutValue = timeoutMs == null || timeoutMs === 0 ? 0 : asNumber(timeoutMs);
  const timeoutId = controller && timeoutValue > 0
    ? setTimeout(() => controller.abort(), Math.max(500, timeoutValue))
    : null;

  const requestBody = {
    model,
    input: normalizeInput(input),
  };
  if (instructions) requestBody.instructions = String(instructions);
  if (typeof previousResponseId === "string" && previousResponseId.trim()) {
    requestBody.previous_response_id = previousResponseId.trim();
  }
  if (Array.isArray(tools) && tools.length) requestBody.tools = tools;
  if (toolChoice != null) requestBody.tool_choice = toolChoice;
  if (metadata && typeof metadata === "object") requestBody.metadata = metadata;
  if (asNumber(temperature) != null) requestBody.temperature = Number(temperature);
  if (asNumber(maxOutputTokens) != null && Number(maxOutputTokens) > 0) {
    requestBody.max_output_tokens = Number(maxOutputTokens);
  }
  if (responseFormat && typeof responseFormat === "object") {
    requestBody.text = {
      ...(requestBody.text || {}),
      format: responseFormat,
    };
  }

  responsesLog("creating response", {
    model,
    hasInstructions: Boolean(instructions),
    hasResponseFormat: Boolean(responseFormat),
    hasPreviousResponseId: Boolean(previousResponseId),
    toolCount: Array.isArray(tools) ? tools.length : 0,
  });

  try {
    const response = await fetch(RESPONSES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: controller?.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      const apiErrorMessage = extractApiErrorMessage(errorBody);
      const errorMessage = apiErrorMessage
        ? `HTTP ${response.status}: ${apiErrorMessage}`
        : `HTTP ${response.status}`;
      responsesLog("responses API error", {
        status: response.status,
        body: compactText(errorBody, 320),
      });
      emitTrace(onTrace, {
        status: "http_error",
        request_summary: compactText({ model, input }),
        response_summary: compactText(errorBody, 280),
        error_message: errorMessage,
      });
      return {
        ok: false,
        status: "http_error",
        error: errorMessage,
        responseId: null,
        outputText: "",
        outputJson: null,
        toolCalls: [],
        data: null,
      };
    }

    const data = await response.json().catch(() => null);
    const outputText = extractOutputText(data || {});
    const outputJson = safeJsonParse(outputText);
    const toolCalls = extractToolCalls(data || {});

    emitTrace(onTrace, {
      status: "ok",
      request_summary: compactText({ model, input, responseFormat: responseFormat?.name || responseFormat?.type || null }, 320),
      response_summary: compactText(outputText || data, 320),
      error_message: "",
    });

    return {
      ok: true,
      status: String(data?.status || "completed"),
      error: null,
      responseId: data?.id || null,
      outputText,
      outputJson,
      toolCalls,
      data,
    };
  } catch (error) {
    const timeout = error?.name === "AbortError";
    const status = timeout ? "timeout" : "error";
    responsesLog("responses request failed", {
      status,
      message: error?.message || String(error),
    });
    emitTrace(onTrace, {
      status,
      request_summary: compactText({ model, input }),
      response_summary: "",
      error_message: error?.message || String(error),
    });
    return {
      ok: false,
      status,
      error: error?.message || String(error),
      responseId: null,
      outputText: "",
      outputJson: null,
      toolCalls: [],
      data: null,
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

module.exports = {
  createResponse,
  extractOutputText,
};
