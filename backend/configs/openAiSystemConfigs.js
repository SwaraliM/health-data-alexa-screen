/**
 * backend/configs/openAiSystemConfigs.js
 *
 * Single source of truth for:
 * - planner schema
 * - speech prompt
 * - presentation prompt
 * - chart families / palette
 *
 * This version is aligned with:
 * - daily + intraday Fitbit metrics
 * - comparisons across 2+ metrics
 * - gauge-first status views
 * - no single-value cards
 */

const VISUAL_SYSTEM = {
  app: {
    voiceMaxWords: 28,
    voiceMaxChars: 180,
    maxStages: 3,
    defaultTimeScope: "last_7_days",
    supportedTimeScopes: [
      "today",
      "yesterday",
      "last_night",
      "this_week",
      "last_week",
      "last_7_days",
      "last_30_days",
    ],
  },

  voice: {
    maxWords: 28,
    maxChars: 180,
    maxSentences: 2,
  },

  allowed: {
    questionTypes: [
      "status",
      "comparison",
      "pattern",
      "relationship",
      "goal",
      "explain_chart",
      "coaching",
      "reminder",
      "unsupported",
    ],
    metrics: [
      "steps",
      "distance",
      "floors",
      "elevation",
      "calories",
      "sleep_minutes",
      "sleep_efficiency",
      "wake_minutes",
      "resting_hr",
      "heart_intraday",
      "steps_intraday",
      "calories_intraday",
      "distance_intraday",
      "floors_intraday",
      "hrv",
    ],
    comparisonModes: ["none", "previous_period"],
    chartTypes: [
      "bar",
      "grouped_bar",
      "line",
      "gauge",
      "list_summary",
      "pie",
    ],
    stageTypes: [
      "summary",
      "comparison",
      "relationship",
      "explanation",
      "tip",
    ],
  },

  proxyMap: {
    energy: "steps",
    fatigue: "sleep_minutes",
    recovery: "hrv",
    exercise: "calories",
    activity: "steps",
    movement: "steps",
  },

  metricAliases: {
    heart: "resting_hr",
    pulse: "resting_hr",
    stress: "hrv",
    walking: "steps",
  },

  timeScopeConfig: {
    today: { baseDays: 1, label: "today", offsetDays: 0 },
    yesterday: { baseDays: 1, label: "yesterday", offsetDays: 1 },
    last_night: { baseDays: 1, label: "last night", offsetDays: 1 },
    this_week: { baseDays: 7, label: "this week", offsetDays: 0 },
    last_week: { baseDays: 7, label: "last week", offsetDays: 7 },
    last_7_days: { baseDays: 7, label: "last 7 days", offsetDays: 0 },
    last_30_days: { baseDays: 30, label: "last 30 days", offsetDays: 0 },
  },

  chartDefaults: {
    axisFontSize: 14,
    labelFontSize: 14,
    titleFontSize: 18,
    subtitleFontSize: 14,
    barRadius: 10,
    lineWidth: 4,
    gaugeFontSize: 40,
  },

  palettes: {
    steps: {
      primary: "#0EA5E9",
      secondary: "#14B8A6",
      accent: "#F59E0B",
      background: "#F0F9FF",
      text: "#0F172A",
      series: ["#0EA5E9", "#14B8A6", "#F59E0B", "#8B5CF6", "#EF4444", "#22C55E"],
    },
    distance: {
      primary: "#14B8A6",
      secondary: "#0EA5E9",
      accent: "#F59E0B",
      background: "#ECFDF5",
      text: "#0F172A",
      series: ["#14B8A6", "#0EA5E9", "#F59E0B", "#8B5CF6"],
    },
    floors: {
      primary: "#F59E0B",
      secondary: "#F97316",
      accent: "#0EA5E9",
      background: "#FFFBEB",
      text: "#0F172A",
      series: ["#F59E0B", "#F97316", "#0EA5E9", "#8B5CF6"],
    },
    elevation: {
      primary: "#84CC16",
      secondary: "#14B8A6",
      accent: "#F59E0B",
      background: "#F7FEE7",
      text: "#0F172A",
      series: ["#84CC16", "#14B8A6", "#F59E0B", "#0EA5E9"],
    },
    calories: {
      primary: "#F97316",
      secondary: "#F59E0B",
      accent: "#E11D48",
      background: "#FFF7ED",
      text: "#0F172A",
      series: ["#F97316", "#F59E0B", "#E11D48", "#0EA5E9", "#8B5CF6"],
    },
    sleep_minutes: {
      primary: "#5B6CFF",
      secondary: "#8B5CF6",
      accent: "#2DD4BF",
      background: "#EEF2FF",
      text: "#0F172A",
      series: ["#5B6CFF", "#8B5CF6", "#2DD4BF", "#F59E0B", "#06B6D4"],
    },
    sleep_efficiency: {
      primary: "#6366F1",
      secondary: "#8B5CF6",
      accent: "#2DD4BF",
      background: "#EEF2FF",
      text: "#0F172A",
      series: ["#6366F1", "#8B5CF6", "#2DD4BF", "#F59E0B"],
    },
    wake_minutes: {
      primary: "#FB7185",
      secondary: "#F43F5E",
      accent: "#F59E0B",
      background: "#FFF1F2",
      text: "#0F172A",
      series: ["#FB7185", "#F43F5E", "#F59E0B", "#8B5CF6"],
    },
    resting_hr: {
      primary: "#E11D48",
      secondary: "#FB7185",
      accent: "#F59E0B",
      background: "#FFF1F2",
      text: "#0F172A",
      series: ["#E11D48", "#FB7185", "#F59E0B", "#06B6D4", "#8B5CF6"],
    },
    heart_intraday: {
      primary: "#DC2626",
      secondary: "#FB7185",
      accent: "#F59E0B",
      background: "#FEF2F2",
      text: "#0F172A",
      series: ["#DC2626", "#FB7185", "#F59E0B", "#8B5CF6"],
    },
    steps_intraday: {
      primary: "#0284C7",
      secondary: "#14B8A6",
      accent: "#F59E0B",
      background: "#F0F9FF",
      text: "#0F172A",
      series: ["#0284C7", "#14B8A6", "#F59E0B", "#8B5CF6"],
    },
    calories_intraday: {
      primary: "#EA580C",
      secondary: "#F59E0B",
      accent: "#E11D48",
      background: "#FFF7ED",
      text: "#0F172A",
      series: ["#EA580C", "#F59E0B", "#E11D48", "#0EA5E9"],
    },
    distance_intraday: {
      primary: "#0D9488",
      secondary: "#0EA5E9",
      accent: "#F59E0B",
      background: "#F0FDFA",
      text: "#0F172A",
      series: ["#0D9488", "#0EA5E9", "#F59E0B", "#8B5CF6"],
    },
    floors_intraday: {
      primary: "#D97706",
      secondary: "#F97316",
      accent: "#0EA5E9",
      background: "#FFFBEB",
      text: "#0F172A",
      series: ["#D97706", "#F97316", "#0EA5E9", "#8B5CF6"],
    },
    hrv: {
      primary: "#8B5CF6",
      secondary: "#14B8A6",
      accent: "#F59E0B",
      background: "#F5F3FF",
      text: "#0F172A",
      series: ["#8B5CF6", "#14B8A6", "#5B6CFF", "#F59E0B", "#06B6D4"],
    },
    relationship: {
      primary: "#5B6CFF",
      secondary: "#14B8A6",
      accent: "#F59E0B",
      background: "#EEF2FF",
      text: "#0F172A",
      series: ["#5B6CFF", "#14B8A6", "#F59E0B", "#EF4444", "#8B5CF6", "#06B6D4"],
    },
    fallback: {
      primary: "#2563EB",
      secondary: "#14B8A6",
      accent: "#F59E0B",
      background: "#EFF6FF",
      text: "#0F172A",
      series: ["#2563EB", "#14B8A6", "#F59E0B", "#8B5CF6", "#EF4444", "#06B6D4"],
    },
  },
};

function metricToPalette(metricKey) {
  return VISUAL_SYSTEM.palettes[metricKey] || VISUAL_SYSTEM.palettes.fallback;
}

const FETCH_PLAN_SCHEMA = {
  name: "fitbit_fetch_plan",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      question_type: {
        type: "string",
        enum: VISUAL_SYSTEM.allowed.questionTypes,
      },
      metrics_needed: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        items: {
          type: "string",
          enum: VISUAL_SYSTEM.allowed.metrics,
        },
      },
      time_scope: {
        type: "string",
        enum: VISUAL_SYSTEM.app.supportedTimeScopes,
      },
      comparison_mode: {
        type: "string",
        enum: VISUAL_SYSTEM.allowed.comparisonModes,
      },
      preferred_chart: {
        type: "string",
        enum: VISUAL_SYSTEM.allowed.chartTypes,
      },
    },
    required: [
      "question_type",
      "metrics_needed",
      "time_scope",
      "comparison_mode",
      "preferred_chart",
    ],
  },
};

const PRESENTATION_SCHEMA = {
  name: "fitbit_present_response",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: {
        type: "object",
        additionalProperties: false,
        properties: {
          shortSpeech: { type: "string" },
          shortText: { type: "string" },
        },
        required: ["shortSpeech", "shortText"],
      },
      stages: {
        type: "array",
        minItems: 1,
        maxItems: 3,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            cue: { type: "string" },
            speech: { type: "string" },
            screenText: { type: "string" },
            stage_type: {
              type: "string",
              enum: VISUAL_SYSTEM.allowed.stageTypes,
            },
            chart_type: {
              type: "string",
              enum: VISUAL_SYSTEM.allowed.chartTypes,
            },
            takeaway: { type: "string" },
            icon: { type: "string" },
          },
          required: [
            "id",
            "title",
            "cue",
            "speech",
            "screenText",
            "stage_type",
            "chart_type",
            "takeaway",
            "icon",
          ],
        },
      },
      suggestedQuestions: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        items: { type: "string" },
      },
    },
    required: ["summary", "stages", "suggestedQuestions"],
  },
};

const FOLLOWUP_SCHEMA = {
  name: "fitbit_followup_response",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      answer: { type: "string" },
      suggestedQuestions: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        items: { type: "string" },
      },
    },
    required: ["answer", "suggestedQuestions"],
  },
};

const FETCH_PLANNER_CONFIG = {
  model: process.env.OPENAI_QNA_MODEL || "gpt-4o-mini",
  temperature: 0.1,
  maxTokens: 260,
  timeoutMs: 1200,
  jsonSchema: FETCH_PLAN_SCHEMA,
  systemPrompt: [
    "You are the fetch planner for a Fitbit voice assistant.",
    "Your job is ONLY to decide what Fitbit data should be fetched first.",
    "Do not analyze the data yet.",
    "Return only strict JSON.",
    "Choose the minimum useful data needed to answer the user well.",
    "Output only: question_type, metrics_needed, time_scope, comparison_mode, preferred_chart.",
    "Prefer gauge for status questions when a meaningful goal exists. Avoid single-number cards.",
    "Use intraday metrics when the user asks about within-day timing, hourly patterns, spikes, dips, today by hour, this morning, this afternoon, or during the day.",
    "For comparisons across multiple health metrics, you may request up to 4 metrics when they share a meaningful time axis.",
    "For relationship questions, prefer line when the goal is to show how two or more metrics move together over time.",
    "If the user asks about energy, use steps as a proxy unless sleep or calories is clearly better.",
    "Use comparison_mode previous_period when the user asks to compare to last week or the prior period.",
    "preferred_chart should be simple and layperson-friendly.",
  ].join(" "),
};

const PRESENT_CONFIG = {
  model: process.env.OPENAI_QNA_MODEL || "gpt-4o-mini",
  temperature: 0.35,
  maxTokens: 900,
  timeoutMs: 18000,
  jsonSchema: PRESENTATION_SCHEMA,
  systemPrompt: [
    "You are the visual presentation writer for a Fitbit smart-screen assistant.",
    "The user is a lay person and may be an older adult.",
    "Your response should feel premium, warm, understandable, and encouraging.",
    "You will receive a question plus already computed health facts from code.",
    "Computed facts are authoritative. Do not replace or alter those numbers.",
    "Do not invent numbers.",
    "Do not give medical diagnosis or treatment advice.",
    "Use plain language and explain what matters.",
    "summary.shortSpeech must be 1 or 2 short complete spoken sentences.",
    "summary.shortText can be richer and more helpful for the screen.",
    "Create up to 3 stages that guide the user deeper: summary, comparison or explanation, then tips when useful.",
    "Prefer gauges for progress to goal, bars for short daily summaries, grouped bars for previous-period comparison, lines for longer trends or multiple metrics moving together, pies for sleep stage breakdowns, and list_summary for tip-heavy or explanation-heavy stages.",
    "Use colorful, elegant, premium health-tech language, but keep it easy to understand.",
    "Return only strict JSON.",
  ].join(" "),
};

const SPEECH_CONFIG = {
  model: process.env.OPENAI_QNA_MODEL || "gpt-4o-mini",
  temperature: 0.15,
  maxTokens: 400,
  timeoutMs: 3500,
  systemPrompt: [
    "You write one Alexa spoken answer for the user's Fitbit data.",
    "You receive pre-computed facts. Do not invent or change numbers.",
    "Produce exactly 1 or 2 short, warm, conversational sentences. Make sure that the sentences are COMPLETE",
    "Use plain language an older adult would understand.",
    "Do not give medical diagnosis or treatment advice.",
    "Do not add greetings, sign-offs, or filler.",
    "Output only the spoken text.",
  ].join(" "),
};

const FOLLOWUP_CONFIG = {
  model: process.env.OPENAI_QNA_MODEL || "gpt-4o-mini",
  temperature: 0.25,
  maxTokens: 400,
  timeoutMs: 1800,
  jsonSchema: FOLLOWUP_SCHEMA,
  systemPrompt: [
    "You answer a follow-up question about a health chart already on screen.",
    "Keep the answer to one or two plain-language sentences.",
    "Do not invent numbers and do not give medical advice.",
    "Be helpful, calm, and easy to understand.",
    "Return only strict JSON.",
  ].join(" "),
};

module.exports = {
  VISUAL_SYSTEM,
  metricToPalette,
  FETCH_PLANNER_CONFIG,
  PRESENT_CONFIG,
  SPEECH_CONFIG,
  FOLLOWUP_CONFIG,
};