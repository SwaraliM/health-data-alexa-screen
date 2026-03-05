/**
 * backend/routers/aiRouter.js
 *
 * Helper API routes for local testing/non-Alexa clients.
 *
 * This router mirrors the same planner + deterministic chart_spec pipeline
 * used by alexaRouter, without extra visualization branches.
 */

const express = require("express");
const { SERVER_ERROR } = require("../../utils/constants");
const { buildQnaPayload } = require("../services/qnaEngine");

const aiRouter = express.Router();

const qnaCache = new Map();
const QNA_CACHE_TTL_MS = 5 * 60 * 1000;

function getCacheKey(username, question) {
  return `${String(username || "").toLowerCase()}::${String(question || "").toLowerCase()}`;
}

function getCached(cacheKey) {
  const entry = qnaCache.get(cacheKey);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > QNA_CACHE_TTL_MS) {
    qnaCache.delete(cacheKey);
    return null;
  }
  return entry.payload;
}

function setCached(cacheKey, payload) {
  qnaCache.set(cacheKey, { timestamp: Date.now(), payload });
}

/**
 * POST /api/ai/qna-ask
 * Returns planner output + validated chart_spec payload.
 */
aiRouter.post("/qna-ask", async (req, res) => {
  const username = String(req.body?.username || "amy").trim().toLowerCase();
  const question = String(req.body?.question || "").trim();
  if (!question) return res.status(400).json({ error: "question is required" });

  const cacheKey = getCacheKey(username, question);
  const cached = getCached(cacheKey);
  if (cached) return res.status(200).json({ ...cached, _cache: true });

  try {
    const built = await buildQnaPayload({
      username,
      question,
      allowPlannerLLM: true,
      fetchTimeoutMs: 3500,
    });

    const payload = {
      payload: built.payload,
      planner: built.planner,
      voice_answer: built.payload?.voice_answer || "",
      chart_spec: built.payload?.chart_spec || null,
    };

    setCached(cacheKey, payload);
    return res.status(200).json(payload);
  } catch (error) {
    return res.status(500).json({
      error: SERVER_ERROR,
      details: "I had trouble preparing that chart. Please try a simpler question.",
    });
  }
});

module.exports = aiRouter;
