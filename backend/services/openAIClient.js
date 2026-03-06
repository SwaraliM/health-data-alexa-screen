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

async function callOpenAIJson({
  systemPrompt,
  userPayload,
  model = process.env.OPENAI_QNA_MODEL || "gpt-4o-mini",
  maxTokens = 320,
  temperature = 0.2,
  timeoutMs = 2500,
  jsonSchema = null,
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.log("[OpenAI] OPENAI_API_KEY missing, skipping request.");
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs) || 2500));

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
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature,
        max_tokens: maxTokens,
        response_format: responseFormat,
        messages: [
          { role: "system", content: String(systemPrompt || "") },
          { role: "user", content: JSON.stringify(userPayload ?? {}) },
        ],
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.log("[OpenAI] HTTP error", response.status, body.slice(0, 200));
      return null;
    }

    const data = await response.json().catch(() => null);
    const content = data?.choices?.[0]?.message?.content;
    const parsed = safeJsonParse(content);

    if (!parsed || typeof parsed !== "object") {
      console.log("[OpenAI] Invalid JSON content", typeof content === "string" ? content.slice(0, 200) : "");
      return null;
    }

    return parsed;
  } catch (err) {
    console.log("[OpenAI] Request failed:", err?.message || String(err));
    return null;
  } finally {
    clearTimeout(timeoutId);
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
  maxTokens = 80,
  temperature = 0.15,
  timeoutMs = 3500,
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.log("[OpenAI-stream] OPENAI_API_KEY missing, skipping.");
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs) || 3500));

  try {
    const response = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature,
        max_tokens: maxTokens,
        stream: true,
        messages: [
          { role: "system", content: String(systemPrompt || "") },
          { role: "user", content: String(userMessage || "") },
        ],
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.log("[OpenAI-stream] HTTP error", response.status, body.slice(0, 200));
      return null;
    }

    const reader = response.body;
    if (!reader) {
      console.log("[OpenAI-stream] No response body");
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
      return null;
    }
    return result;
  } catch (err) {
    if (err.name === "AbortError") {
      console.log("[OpenAI-stream] Timeout after", timeoutMs, "ms");
    } else {
      console.log("[OpenAI-stream] Request failed:", err?.message || String(err));
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = {
  callOpenAIJson,
  callOpenAIStreaming,
};