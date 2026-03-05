/**
 * backend/configs/openAiSystemConfigs.js
 *
 * Single source of truth for the QnA planner pipeline.
 *
 * Why this file exists:
 * - Keeps allowed planner schema + chart constraints in one place.
 * - Keeps visual palette rules in one place.
 * - Avoids drift between backend planning logic and frontend rendering.
 */

const VISUAL_SYSTEM = {
  app: {
    voiceMaxWords: 22,
    maxStages: 3,
    defaultTimeScope: "last_7_days",
    supportedTimeScopes: ["last_7_days", "last_30_days"],
  },

  allowed: {
    questionTypes: [
      "status",
      "comparison",
      "pattern",
      "relationship",
      "goal",
      "explain_chart",
      "reminder",
      "coaching",
      "unsupported",
    ],
    metrics: ["steps", "sleep_minutes", "resting_hr", "calories", "hrv"],
    comparisonModes: ["none", "previous_period"],
    chartTypes: ["bar", "grouped_bar", "line", "gauge", "pie", "single_value", "list_summary"],
  },

  palettes: {
    steps: {
      primary: "#14B8A6",
      secondary: "#0EA5E9",
      accent: "#F59E0B",
      background: "#EAFDF9",
      text: "#12324B",
      series: ["#14B8A6", "#0EA5E9", "#F59E0B", "#8B5CF6", "#EF4444", "#22C55E"],
    },
    sleep_minutes: {
      primary: "#5B6CFF",
      secondary: "#8B5CF6",
      accent: "#2DD4BF",
      background: "#EEF2FF",
      text: "#1F2A56",
      series: ["#5B6CFF", "#8B5CF6", "#2DD4BF", "#F59E0B", "#EF4444", "#06B6D4"],
    },
    resting_hr: {
      primary: "#E11D48",
      secondary: "#FB7185",
      accent: "#F59E0B",
      background: "#FFF1F5",
      text: "#4A1025",
      series: ["#E11D48", "#FB7185", "#F59E0B", "#8B5CF6", "#06B6D4", "#EF4444"],
    },
    calories: {
      primary: "#F97316",
      secondary: "#F59E0B",
      accent: "#E11D48",
      background: "#FFF7ED",
      text: "#5A2C08",
      series: ["#F97316", "#F59E0B", "#E11D48", "#0EA5E9", "#8B5CF6", "#22C55E"],
    },
    hrv: {
      primary: "#8B5CF6",
      secondary: "#14B8A6",
      accent: "#F59E0B",
      background: "#F5F3FF",
      text: "#2E1A4E",
      series: ["#8B5CF6", "#14B8A6", "#5B6CFF", "#F59E0B", "#06B6D4", "#EF4444"],
    },
    relationship: {
      primary: "#5B6CFF",
      secondary: "#14B8A6",
      accent: "#F59E0B",
      background: "#EEF2FF",
      text: "#1F2A56",
      series: ["#5B6CFF", "#14B8A6", "#F59E0B", "#EF4444", "#8B5CF6", "#06B6D4"],
    },
    fallback: {
      primary: "#2563EB",
      secondary: "#14B8A6",
      accent: "#F59E0B",
      background: "#EFF6FF",
      text: "#1E3A8A",
      series: ["#2563EB", "#14B8A6", "#F59E0B", "#8B5CF6", "#EF4444", "#06B6D4"],
    },
  },
};

function metricToPalette(metricKey) {
  return VISUAL_SYSTEM.palettes[metricKey] || VISUAL_SYSTEM.palettes.fallback;
}

const PHIA_QNA_CONFIG = {
  models: {
    planner: process.env.OPENAI_QNA_MODEL || "gpt-4o-mini",
    followup: process.env.OPENAI_QNA_MODEL || "gpt-4o-mini",
  },

  planner: {
    maxTokens: 520,
    temperature: 0.1,
    systemPrompt: [
      "You are a planner for a voice-first, chart-first Fitbit assistant for older adults.",
      "Return ONLY strict JSON with keys: question_type, metrics_needed, time_scope, comparison_mode, voice_answer, suggested_follow_up, chart_spec.",
      "question_type must be one of: status, comparison, pattern, relationship, goal, explain_chart, reminder, coaching, unsupported.",
      "metrics_needed must be an array of 1-2 items from: steps, sleep_minutes, resting_hr, calories, hrv.",
      "time_scope must be one of: last_7_days, last_30_days.",
      "comparison_mode must be one of: none, previous_period.",
      "voice_answer must be short and plain language (max 22 words).",
      "suggested_follow_up must be an array of 1-4 short questions.",
      "chart_spec must include keys: chart_type, title, subtitle, takeaway.",
      "Allowed chart_type values: bar, grouped_bar, line, gauge, pie, single_value, list_summary.",
      "Prefer simple visuals: bar, grouped_bar, line, gauge, single_value, list_summary.",
      "Use pie only when category proportions are central to the question.",
      "Do not output React code, HTML, markdown, images, or arbitrary component trees.",
      "Prioritize readability for laypeople and non-technical older adults.",
      "If uncertain, choose conservative assumptions and avoid medical claims.",
    ].join(" "),
  },

  followup: {
    maxTokens: 260,
    temperature: 0.2,
    systemPrompt: [
      "You answer a follow-up question about a health chart on screen.",
      "Return ONLY JSON with keys: answer, suggestedQuestions.",
      "answer should be one or two short plain-language sentences.",
      "suggestedQuestions should contain 1-4 short follow-up questions.",
      "No medical diagnosis and no treatment advice.",
    ].join(" "),
  },
};

// Backwards compatibility for older imports.
const SYSTEM_CONFIG = PHIA_QNA_CONFIG;

module.exports = {
  VISUAL_SYSTEM,
  metricToPalette,
  PHIA_QNA_CONFIG,
  SYSTEM_CONFIG,
};
