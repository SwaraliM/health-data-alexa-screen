/**
 * Centralized OpenAI helper.
 *
 * Why keep this tiny wrapper?
 * - Routers and services should not repeat fetch / timeout / JSON parsing logic.
 * - If you later move from Chat Completions to Responses API, this is the one file to swap.
 *
 * Note:
 * OpenAI recommends the newer Responses-style tool-calling workflow for new builds.
 * This project still uses a compact JSON-only chat completion call here for compatibility with the current codebase.
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
  timeoutMs = 4000,
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs) || 4000));

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
        max_completion_tokens: maxTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: String(systemPrompt || "").trim() },
          { role: "user", content: JSON.stringify(userPayload ?? {}) },
        ],
      }),
    });

    if (!response.ok) return null;

    const data = await response.json().catch(() => null);
    const content = data?.choices?.[0]?.message?.content;
    const parsed = safeJsonParse(content);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = {
  callOpenAIJson,
};