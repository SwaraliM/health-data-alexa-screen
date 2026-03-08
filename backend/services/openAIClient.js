/**
 * backend/services/openAIClient.js
 *
 * Shared OpenAI helpers.
 * Supports:
 * - plain json_object mode  (callOpenAIJson)
 * - json_schema mode        (callOpenAIJson)
 * - streaming text mode     (callOpenAIStreaming)
 *
 * Returns null on timeout/error so the app can fall back gracefully.
 */

require("dotenv").config();

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

function safeJsonParse(text) {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function compactText(value, max = 240) {
  const text = typeof value === "string"
    ? value
    : value == null
      ? ""
      : JSON.stringify(value);
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function emitTrace(onTrace, trace) {
  if (typeof onTrace !== "function") return;
  try {
    onTrace(trace);
  } catch (_) {
    // Trace emission must never break the main request path.
  }
}

async function callOpenAIJson({
  systemPrompt,
  userPayload,
  model = process.env.OPENAI_QNA_MODEL || "gpt-4o-mini",
  maxTokens = null,
  temperature = 0.2,
  timeoutMs = null,
  jsonSchema = null,
  onTrace = null,
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.log("[OpenAI] OPENAI_API_KEY missing, skipping request.");
    emitTrace(onTrace, {
      status: "skipped",
      request_summary: compactText({ model, userPayload }),
      response_summary: "",
      error_message: "OPENAI_API_KEY missing",
    });
    return null;
  }

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timeoutEnabled = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0;
  const timeoutId = timeoutEnabled && controller
    ? setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs)))
    : null;

  const responseFormat = jsonSchema
    ? { type: "json_schema", json_schema: jsonSchema }
    : { type: "json_object" };

  try {
    const response = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller?.signal,
      body: JSON.stringify({
        model,
        temperature,
        response_format: responseFormat,
        messages: [
          { role: "system", content: String(systemPrompt || "") },
          { role: "user", content: JSON.stringify(userPayload ?? {}) },
        ],
        ...(Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0
          ? { max_tokens: Number(maxTokens) }
          : {}),
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.log("[OpenAI] HTTP error", response.status, body.slice(0, 200));
      emitTrace(onTrace, {
        status: "http_error",
        request_summary: compactText({ model, userPayload }),
        response_summary: compactText(body, 280),
        error_message: `HTTP ${response.status}`,
      });
      return null;
    }

    const data = await response.json().catch(() => null);
    const content = data?.choices?.[0]?.message?.content;
    const parsed = safeJsonParse(content);

    if (!parsed || typeof parsed !== "object") {
      console.log("[OpenAI] Invalid JSON content", typeof content === "string" ? content.slice(0, 200) : "");
      emitTrace(onTrace, {
        status: "invalid_json",
        request_summary: compactText({ model, userPayload }),
        response_summary: compactText(content, 280),
        error_message: "Model returned invalid JSON",
      });
      return null;
    }

    emitTrace(onTrace, {
      status: "ok",
      request_summary: compactText({
        model,
        systemPrompt: compactText(systemPrompt, 140),
        userPayload,
        schema: jsonSchema?.name || null,
      }, 320),
      response_summary: compactText(parsed, 320),
      error_message: "",
    });
    return parsed;
  } catch (err) {
    console.log("[OpenAI] Request failed:", err?.message || String(err));
    emitTrace(onTrace, {
      status: err?.name === "AbortError" ? "timeout" : "error",
      request_summary: compactText({ model, userPayload }),
      response_summary: "",
      error_message: err?.message || String(err),
    });
    return null;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/**
 * Streaming text completion. Accumulates SSE chunks and returns the full
 * text once the stream closes. Returns null on timeout/error so callers
 * can fall back to a deterministic answer.
 */
async function callOpenAIStreaming({
  systemPrompt,
  userMessage,
  model = process.env.OPENAI_QNA_MODEL || "gpt-4o-mini",
  maxTokens = null,
  temperature = 0.15,
  timeoutMs = null,
  onTrace = null,
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.log("[OpenAI-stream] OPENAI_API_KEY missing, skipping.");
    emitTrace(onTrace, {
      status: "skipped",
      request_summary: compactText({ model, userMessage }),
      response_summary: "",
      error_message: "OPENAI_API_KEY missing",
    });
    return null;
  }

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timeoutEnabled = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0;
  const timeoutId = timeoutEnabled && controller
    ? setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs)))
    : null;

  try {
    const response = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller?.signal,
      body: JSON.stringify({
        model,
        temperature,
        stream: true,
        messages: [
          { role: "system", content: String(systemPrompt || "") },
          { role: "user", content: String(userMessage || "") },
        ],
        ...(Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0
          ? { max_tokens: Number(maxTokens) }
          : {}),
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.log("[OpenAI-stream] HTTP error", response.status, body.slice(0, 200));
      emitTrace(onTrace, {
        status: "http_error",
        request_summary: compactText({ model, userMessage }),
        response_summary: compactText(body, 280),
        error_message: `HTTP ${response.status}`,
      });
      return null;
    }

    const reader = response.body;
    if (!reader) {
      console.log("[OpenAI-stream] No response body");
      emitTrace(onTrace, {
        status: "empty_body",
        request_summary: compactText({ model, userMessage }),
        response_summary: "",
        error_message: "No response body",
      });
      return null;
    }

    let accumulated = "";
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    for await (const chunk of reader) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const payload = trimmed.slice(6);
        if (payload === "[DONE]") break;

        const parsed = safeJsonParse(payload);
        const delta = parsed?.choices?.[0]?.delta?.content;
        if (typeof delta === "string") accumulated += delta;
      }
    }

    const result = accumulated.trim();
    if (!result) {
      console.log("[OpenAI-stream] Empty accumulated text");
      emitTrace(onTrace, {
        status: "empty",
        request_summary: compactText({ model, userMessage }),
        response_summary: "",
        error_message: "Empty accumulated text",
      });
      return null;
    }
    emitTrace(onTrace, {
      status: "ok",
      request_summary: compactText({
        model,
        systemPrompt: compactText(systemPrompt, 140),
        userMessage,
      }, 320),
      response_summary: compactText(result, 320),
      error_message: "",
    });
    return result;
  } catch (err) {
    if (err.name === "AbortError") {
      console.log("[OpenAI-stream] Timeout after", timeoutMs, "ms");
    } else {
      console.log("[OpenAI-stream] Request failed:", err?.message || String(err));
    }
    emitTrace(onTrace, {
      status: err?.name === "AbortError" ? "timeout" : "error",
      request_summary: compactText({ model, userMessage }),
      response_summary: "",
      error_message: err?.message || String(err),
    });
    return null;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

module.exports = {
  callOpenAIJson,
  callOpenAIStreaming,
};
