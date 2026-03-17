/**
 * backend/configs/agentConfigs.js
 *
 * Shared planner + executor configs for the lightweight agentic migration.
 * Phase 4 adds executor stage-generation settings while keeping planner
 * behavior backward compatible.
 */

function asNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asBoolean(value, fallback) {
  if (value == null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function asList(value, fallback = []) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item || "").trim().toLowerCase())
      .filter(Boolean);
  }
  if (value == null || value === "") return fallback.slice();
  return String(value)
    .split(",")
    .map((item) => String(item || "").trim().toLowerCase())
    .filter(Boolean);
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const bounded = Math.floor(parsed);
  return Math.min(max, Math.max(min, bounded));
}

const PLANNER_ALLOWED_MODES = [
  "new_analysis",
  "continue_analysis",
  "branch_analysis",
];

const PLANNER_ALLOWED_TIME_SCOPES = [
  "today",
  "yesterday",
  "last_night",
  "this_week",
  "last_week",
  "last_7_days",
  "last_30_days",
];

const PLANNER_ALLOWED_STAGE_TYPES = [
  "overview",
  "trend",
  "relationship",
  "comparison",
  "takeaway",
  "anomaly",
  "goal_progress",
  "intraday_breakdown",
  "sleep_detail",
  "heart_recovery",
];

const EXECUTOR_ALLOWED_CHART_TYPES = [
  "bar",
  "grouped_bar",
  "line",
  "multi_line",
  "stacked_bar",
  "scatter",
  "area",
  "heatmap",
  "radar",
  "boxplot",
  "timeline",
  "gauge",
  "list_summary",
  "pie",
  "composed_summary",
];

const EXECUTOR_READ_TOOLS = [
  "load_bundle",
  "load_bundle_snapshot",
  "get_stage_history",
  "get_normalized_table",
  "get_normalized_bundle_data",
  "get_user_context",
  "fetch_additional_fitbit_data",
];

/**
 * Write-side tool names that the runtime recognizes.
 * Only an explicit allow-list subset should be enabled at a time.
 */
const EXECUTOR_WRITE_TOOLS = [
  "mark_bundle_complete",
  "append_note",
  "append_stage_note",
  "add_bundle_note",
  "append_stage",
  "release_bundle",
];

/**
 * Responses API text.format schema object.
 * Planner should return compact strict JSON only.
 */
const PLANNER_TEXT_FORMAT = {
  type: "json_schema",
  name: "qna_planner_output",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["mode", "metrics_needed", "time_scope", "analysis_goal", "candidate_stage_types"],
    properties: {
      mode: {
        type: "string",
        enum: PLANNER_ALLOWED_MODES,
      },
      metrics_needed: {
        type: "array",
        items: { type: "string" },
        maxItems: 6,
      },
      time_scope: {
        type: "string",
      },
      analysis_goal: {
        type: "string",
        maxLength: 160,
      },
      candidate_stage_types: {
        type: "array",
        items: { type: "string" },
        maxItems: 6,
      },
    },
  },
  strict: true,
};

const PLANNER_SYSTEM_PROMPT = `
You are a PLANNER only for a Fitbit-backed health QnA product used through Alexa + smart screen.

You produce a stage-oriented plan only. Do not produce final answers or chart code. The executor will generate one stage at a time from this plan.

Your job:
- classify user intent as one of: new_analysis, continue_analysis, branch_analysis
- decide which Fitbit metrics are likely needed (metrics_needed)
- decide an appropriate time_scope
- define a concise analysis_goal
- suggest candidate_stage_types for a sequence of visual explanation stages

Planning behavior:
- Plan for 2 to 3 visual explanation stages per question. Each question should be answered with multiple visuals (e.g. overview, then trend, then takeaway), one stage at a time.
- Think in terms of a sequence of visual explanation stages that the executor will fulfill one at a time.
- Stage types should come from: overview, trend, relationship, comparison, takeaway (and schema-allowed types as needed).
- Keep plans practical for older-adult voice-first delivery on Alexa + smart screen.
- If the question refers to current stage/screen context, prefer continue_analysis unless there is a clear topic shift.
- If the user asks "what about X instead" while context is still relevant, prefer branch_analysis.

Hard rules:
- Return strict JSON only matching the required schema.
- Do NOT answer the user question.
- Do NOT provide medical diagnosis.
- Do NOT generate chart code.
`.trim();

/**
 * Executor returns exactly one stage at a time.
 * Keep chart_spec open enough for ECharts option objects while still requiring
 * key stage fields.
 */
const EXECUTOR_TEXT_FORMAT = {
  type: "json_schema",
  name: "qna_executor_stage_output",
  schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "title",
      "spoken_text",
      "screen_text",
      "chart_spec",
      "suggested_followups",
      "more_available",
      "continuation_hint",
      "analysis_notes",
    ],
    properties: {
      title: {
        type: "string",
        maxLength: 120,
      },
      spoken_text: {
        type: "string",
        maxLength: 640,
      },
      screen_text: {
        type: "string",
        maxLength: 700,
      },
      chart_spec: {
        type: "object",
        additionalProperties: false,
        required: ["chart_type", "title", "subtitle", "takeaway", "chart_data", "suggested_follow_up"],
        properties: {
          chart_type: {
            type: "string",
            enum: EXECUTOR_ALLOWED_CHART_TYPES,
          },
          title: {
            type: "string",
            maxLength: 120,
          },
          subtitle: {
            type: "string",
            maxLength: 160,
          },
          takeaway: {
            type: "string",
            maxLength: 220,
          },
          chart_data: {
            type: "object",
            additionalProperties: false,
            properties: {
              labels: { type: "array", items: { type: "string" }, maxItems: 60 },
              series: {
                type: "array",
                maxItems: 6,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["name", "data"],
                  properties: {
                    name: { type: "string", maxLength: 40 },
                    data: { type: "array", items: { type: "number" }, maxItems: 60 },
                  },
                },
              },
              goal_line: { type: "number" },
              reference_line: {
                type: "object",
                additionalProperties: false,
                properties: {
                  value: { type: "number" },
                  label: { type: "string", maxLength: 40 },
                },
                required: ["value", "label"],
              },
              points: {
                type: "array",
                maxItems: 60,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["x", "y", "label"],
                  properties: {
                    x: { type: "number" },
                    y: { type: "number" },
                    label: { anyOf: [{ type: "string", maxLength: 30 }, { type: "null" }] },
                  },
                },
              },
              x_name: { type: "string", maxLength: 40 },
              y_name: { type: "string", maxLength: 40 },
              x_labels: { type: "array", items: { type: "string" }, maxItems: 24 },
              y_labels: { type: "array", items: { type: "string" }, maxItems: 7 },
              data: {
                type: "array",
                items: {
                  type: "array",
                  items: { type: "number" },
                  minItems: 3,
                  maxItems: 3,
                },
              },
              indicators: {
                type: "array",
                maxItems: 8,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["name", "max"],
                  properties: {
                    name: { type: "string", maxLength: 30 },
                    max: { type: "number" },
                  },
                },
              },
              value: { type: "number" },
              min: { type: "number" },
              max: { type: "number" },
              unit: { type: "string", maxLength: 20 },
              slices: {
                type: "array",
                maxItems: 8,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["name", "value"],
                  properties: {
                    name: { type: "string", maxLength: 40 },
                    value: { type: "number" },
                  },
                },
              },
              events: {
                type: "array",
                maxItems: 20,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["date", "label", "value"],
                  properties: {
                    date: { type: "string", maxLength: 20 },
                    label: { type: "string", maxLength: 60 },
                    value: { anyOf: [{ type: "number" }, { type: "null" }] },
                  },
                },
              },
              items: { type: "array", items: { type: "string", maxLength: 110 }, maxItems: 8 },
              cards: {
                type: "array",
                maxItems: 4,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["label", "value", "subvalue"],
                  properties: {
                    label: { type: "string", maxLength: 40 },
                    value: { type: "string", maxLength: 40 },
                    subvalue: { anyOf: [{ type: "string", maxLength: 64 }, { type: "null" }] },
                  },
                },
              },
            },
          },
          suggested_follow_up: {
            type: "array",
            items: { type: "string" },
            maxItems: 4,
          },
        },
      },
      suggested_followups: {
        type: "array",
        items: { type: "string" },
        maxItems: 6,
      },
      more_available: {
        type: "boolean",
      },
      continuation_hint: {
        type: "string",
        maxLength: 200,
      },
      analysis_notes: {
        type: "string",
        maxLength: 280,
      },
    },
  },
  strict: true,
};

const EXECUTOR_SYSTEM_PROMPT = `
You are the EXECUTOR agent for a Fitbit-backed Alexa + smart-screen health QnA product.

Task:
- Read bundle context and normalized Fitbit data rows.
- Generate exactly ONE next stage of analysis per response. Do not output multiple stages or a full report.
- Perform reasoning/inference/calculation in-model from provided normalized data.
- Choose a practical ECharts chart_spec JSON.
- Decide if more stages are available (2 to 3 stages per question total). Set more_available true when there is at least one more visual to show for the same question.
- When generating the final stage (more_available false), end spoken_text with 1 sentence that summarizes the key health insight from all visuals shown.

Rules:
- Return strict JSON matching the required schema.
- Do not output raw frontend code.
- Do not output markdown.
- Do not provide medical diagnosis.
- Every stage must include in spoken_text: (1) one sentence on what is on the screen, (2) what stands out, (3) what it means in plain language.
- Keep spoken_text concise for Alexa timing (usually 3 to 5 short sentences).
- The chart_spec must be directly renderable after backend validation.
- Respect continuation context: if prior stages exist, advance logically rather than repeating.
- This is a voice-first smart-screen experience: explain one chart at a time.
- Do not only state Fitbit facts or raw numbers.
- Narrate for an older adult in calm, supportive, plain language.

Chart data instructions:

You choose chart_type based on what best visualizes the insight.
You fill chart_data with only the fields relevant to your chosen chart_type.
Do NOT include an \"option\" field. The backend builds the ECharts option from your chart_data.
chart_data field guide by chart_type:

bar / line / area / stacked_bar: use labels + series
grouped_bar / multi_line: use labels + series (2-4 series)
scatter: use points + x_name + y_name
heatmap: use x_labels + y_labels + data (as [x,y,value] triples)
radar: use indicators + series
gauge: use value + min + max + unit
pie: use slices
timeline: use events
list_summary / composed_summary: use items + optionally cards

labels must be short date or category strings (e.g. \"Mon\", \"Jan 3\", \"Week 1\")
series[].data must be parallel to labels - same length, numbers only
All values must come from the normalized data rows you were given.
Do not invent or estimate values. Use null for genuinely missing data points.
Keep series to 60 data points maximum.


Good style (use this):
- "Here is what you see on the screen."
- "The bars show..."
- "What stands out is..."
- "This means..."
- Describe the visual concretely using words like bars, line, points, up, down, steady, more, less.
- Focus on one main takeaway per stage.
- Avoid jargon; if needed, explain it immediately in simple words.

Bad style (avoid):
- Raw fact dump only; no chart explanation.
- Technical jargon.
- Multiple dense ideas in one stage.

Keep screen_text aligned with spoken_text and easy to scan.
When more_available is true: include "yes" and "show more" in suggested_followups so the user can say "yes" or "show more" to continue to the next visual. You may end spoken_text with a brief reprompt like "Should I go on?" when more stages remain.
Provide suggested_followups as phrases the user can say next (e.g. "show more", "yes", "go back", "explain that", "compare that", "what does this mean", "start over").
Always include continuation_hint and analysis_notes.
If you do not need extra detail, set continuation_hint to an empty string and analysis_notes to an empty string.
`.trim();

const EXECUTOR_MAX_STAGE_COUNT = Math.max(1, Math.floor(asNumber(process.env.QNA_MAX_STAGE_COUNT, 3)));
const EXECUTOR_MIN_STAGE_COUNT = clampInteger(
  process.env.QNA_MIN_STAGE_COUNT,
  1,
  EXECUTOR_MAX_STAGE_COUNT,
  2
);

const AGENT_CONFIGS = {
  planner: {
    version: "phase2-shadow-v1",
    model: process.env.OPENAI_PLANNER_MODEL || process.env.OPENAI_QNA_MODEL || "gpt-4o-mini",
    temperature: asNumber(process.env.OPENAI_PLANNER_TEMPERATURE, 0.1),
    maxOutputTokens: asNumber(process.env.OPENAI_PLANNER_MAX_TOKENS, 350),
    timeoutMs: process.env.OPENAI_PLANNER_TIMEOUT_MS != null && process.env.OPENAI_PLANNER_TIMEOUT_MS !== ""
      ? asNumber(process.env.OPENAI_PLANNER_TIMEOUT_MS, 4500)
      : null,
    systemPrompt: PLANNER_SYSTEM_PROMPT,
    textFormat: PLANNER_TEXT_FORMAT,
    allowedModes: PLANNER_ALLOWED_MODES,
    allowedTimeScopes: PLANNER_ALLOWED_TIME_SCOPES,
    allowedStageTypes: PLANNER_ALLOWED_STAGE_TYPES,
  },
  executor: {
    version: "phase7-executor-hardened-v1",
    model: process.env.OPENAI_EXECUTOR_MODEL || process.env.OPENAI_QNA_MODEL || "gpt-4o-mini",
    temperature: asNumber(process.env.OPENAI_EXECUTOR_TEMPERATURE, 0.2),
    maxOutputTokens: asNumber(process.env.OPENAI_EXECUTOR_MAX_TOKENS, 700),
    timeoutMs: process.env.OPENAI_EXECUTOR_TIMEOUT_MS != null && process.env.OPENAI_EXECUTOR_TIMEOUT_MS !== ""
      ? asNumber(process.env.OPENAI_EXECUTOR_TIMEOUT_MS, 3600)
      : null,
    maxToolTurns: asNumber(process.env.OPENAI_EXECUTOR_MAX_TOOL_TURNS, 2),
    systemPrompt: EXECUTOR_SYSTEM_PROMPT,
    textFormat: EXECUTOR_TEXT_FORMAT,
    allowedChartTypes: EXECUTOR_ALLOWED_CHART_TYPES,
    /**
     * Phase 7 tool guardrails:
     * - read tools are always explicit
     * - write tools require both writeEnabled=true and allow-list membership
     * - write tools require request/user/bundle ownership context
     */
    toolPolicy: {
      allowedReadTools: EXECUTOR_READ_TOOLS,
      allowedWriteTools: asList(
        process.env.OPENAI_EXECUTOR_ALLOWED_WRITE_TOOLS,
        ["mark_bundle_complete", "append_stage_note"]
      ),
      availableWriteTools: EXECUTOR_WRITE_TOOLS,
      allowedWriteSources: asList(
        process.env.OPENAI_EXECUTOR_ALLOWED_WRITE_SOURCES,
        ["alexa", "web", "followup", "internal"]
      ),
      writeEnabled: asBoolean(process.env.OPENAI_EXECUTOR_WRITE_TOOLS_ENABLED, true),
      requireExplicitWriteAllowList: true,
      requireWriteContext: asBoolean(process.env.OPENAI_EXECUTOR_REQUIRE_WRITE_CONTEXT, true),
      requireBundleMatch: asBoolean(process.env.OPENAI_EXECUTOR_REQUIRE_BUNDLE_MATCH, true),
      requireUserOwnership: asBoolean(process.env.OPENAI_EXECUTOR_REQUIRE_USER_OWNERSHIP, true),
      requireRequestOwnership: asBoolean(process.env.OPENAI_EXECUTOR_REQUIRE_REQUEST_OWNERSHIP, true),
    },
    /**
     * Lightweight audit controls for write attempts and stale request handling.
     */
    audit: {
      enabled: asBoolean(process.env.QNA_AUDIT_ENABLED, true),
      maxInMemoryRecords: asNumber(process.env.QNA_AUDIT_MAX_RECORDS, 400),
      includeReadToolEvents: asBoolean(process.env.QNA_AUDIT_INCLUDE_READ_TOOL_EVENTS, false),
    },
    stageSchema: {
      name: EXECUTOR_TEXT_FORMAT.name,
      requiredFields: [
        "title",
        "spoken_text",
        "screen_text",
        "chart_spec",
        "suggested_followups",
        "more_available",
        "continuation_hint",
        "analysis_notes",
      ],
      chartRequiredFields: ["chart_type", "title", "takeaway", "chart_data"],
    },
    progression: {
      maxStages: EXECUTOR_MAX_STAGE_COUNT,
      minStages: EXECUTOR_MIN_STAGE_COUNT,
      allowOnDemandStageGeneration: asBoolean(process.env.QNA_ALLOW_ON_DEMAND_STAGE_GENERATION, true),
      completeBundleOnFinalStage: asBoolean(process.env.QNA_COMPLETE_BUNDLE_ON_FINAL_STAGE, true),
    },
    fallback: {
      useLegacyStage1Fallback: asBoolean(process.env.USE_LEGACY_STAGE1_FALLBACK, false),
      useLegacyNavigationFallback: asBoolean(process.env.USE_LEGACY_NAV_FALLBACK, false),
    },
    primaryEnabled: asBoolean(process.env.USE_EXECUTOR_PRIMARY, true),
  },
  /**
   * Session/race hardening controls.
   */
  session: {
    strictStaleResultRejection: asBoolean(process.env.QNA_STRICT_STALE_REJECTION, true),
    trackBundleRequestOwnership: asBoolean(process.env.QNA_TRACK_BUNDLE_REQUEST_OWNERSHIP, true),
  },
  /**
   * Follow-up intent labels for continuation/navigation hardening.
   */
  followup: {
    navigationIntentLabels: [
      "show_more",
      "next",
      "back",
      "replay",
      "show_stage",
      "start_over",
      "summarize",
      "explain",
      "compare",
      "what_about",
      "does_affect",
      "tell_me_more",
      "why_is_that",
      "what_stands_out",
      "what_am_i_looking_at",
      "what_does_this_mean",
    ],
  },
};

// ─── Template-Fill Executor V2 ────────────────────────────────────────────────
//
// The V2 path fixes a core reliability problem: in V1 GPT must output complex
// nested chart_data JSON with type-specific fields that vary by chart_type.
// This causes frequent malformed output even with strict JSON schemas.
//
// In V2:
//   - Backend pre-builds chart templates (data already extracted from normalizedTable)
//   - GPT receives 2-3 pre-populated template candidates
//   - GPT only needs to: (1) pick selected_template_index, (2) fill text fields
//   - No nested objects or number arrays from GPT → schema is flat + reliable
//
// Toggle: USE_TEMPLATE_FILL_EXECUTOR=true  (default)

/**
 * Simplified executor output schema for the template-fill path.
 * GPT outputs ONLY text fields + one integer index. No chart data arrays.
 */
const EXECUTOR_TEXT_FORMAT_V2 = {
  type: "json_schema",
  name: "qna_executor_stage_v2",
  schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "title",
      "spoken_text",
      "screen_text",
      "selected_template_index",
      "chart_title",
      "chart_subtitle",
      "chart_takeaway",
      "suggested_followups",
      "more_available",
      "continuation_hint",
      "analysis_notes",
    ],
    properties: {
      title: {
        type: "string",
        maxLength: 120,
      },
      spoken_text: {
        type: "string",
        maxLength: 640,
      },
      screen_text: {
        type: "string",
        maxLength: 700,
      },
      selected_template_index: {
        type: "integer",
        minimum: 0,
        maximum: 2,
        description: "Index (0, 1, or 2) of the best template_candidate for this stage.",
      },
      chart_title: {
        type: "string",
        maxLength: 120,
      },
      chart_subtitle: {
        type: "string",
        maxLength: 160,
      },
      chart_takeaway: {
        type: "string",
        maxLength: 220,
      },
      suggested_followups: {
        type: "array",
        items: { type: "string" },
        maxItems: 6,
      },
      more_available: {
        type: "boolean",
      },
      continuation_hint: {
        type: "string",
        maxLength: 200,
      },
      analysis_notes: {
        type: "string",
        maxLength: 280,
      },
    },
  },
  strict: true,
};

/**
 * System prompt for the template-fill executor (V2).
 *
 * Design goals:
 * - GPT focuses entirely on narration quality (older-adult voice-first)
 * - GPT picks the best pre-built chart template; no data generation needed
 * - Spoken text follows a strict 3-part formula for Alexa delivery
 * - Warm, plain-language tone — like a knowledgeable family member
 */
const EXECUTOR_SYSTEM_PROMPT_V2 = `
You are the EXECUTOR agent for a Fitbit health assistant delivered through Alexa and a smart screen.
Your audience is older adults. Your tone must be warm, calm, and clear — like a caring family member who understands health data.

YOUR JOB FOR THIS RESPONSE:
1. Read the "template_candidates" in the user message. Each candidate has pre-built chart data already extracted from real Fitbit data.
2. Choose the best candidate for this stage by setting "selected_template_index" (0 or 1, or 2 if three candidates are given).
3. Write the text fields: title, spoken_text, screen_text, chart_title, chart_subtitle, chart_takeaway.
4. Set more_available, suggested_followups, continuation_hint, analysis_notes.

HOW TO CHOOSE THE RIGHT TEMPLATE:
- Pick the chart that best visualizes the main insight for this stage.
- For a first stage or overview: prefer a summary or bar chart that shows the full picture.
- For trend stages: prefer line or area charts that show change over time.
- For relationship stages: prefer grouped_bar (side-by-side) over scatter — easier to read.
- For sleep: prefer pie (stage composition) when available.
- Avoid repeating the exact same chart type as the previous stage if another good option exists.

SPOKEN TEXT FORMULA — follow this structure for every stage:
1. ORIENTATION (1 sentence): "Here is what you see on the screen — [describe the chart type and what each axis or slice represents]."
2. HIGHLIGHT (1–2 sentences): "What stands out is [the single most notable finding — use plain words like higher, lower, steady, more, less]."
3. MEANING (1 sentence): "This means [what this finding tells us about the person's health in everyday language]."
4. CONTINUITY (1 sentence, only when more_available is true): "There is more to see — just say 'show more' to continue." OR "Should I go on?"

Total spoken_text length: 3 to 5 short, complete sentences. Never cut off mid-sentence.

STYLE RULES:
- Use at most one number in spoken_text. If you use it, always follow it with what it means in plain words.
  ❌ "Your resting heart rate was 58 bpm."
  ✅ "Your resting heart rate was 58 — lower than usual, which is a good sign your body recovered well."
- Lead with the pattern or meaning, not the observation. Ask: what would a caring doctor say about this?
- Use plain words: "higher", "lower", "fairly steady", "a bit less than usual", "noticeably higher".
- Avoid clinical terms. If you must use one (like "resting heart rate"), explain it immediately:
  "Your resting heart rate — that is how fast your heart beats when you are at rest — ..."
- Do not end with a question to the user UNLESS more_available is true and you are inviting them to continue.
- Screen_text should match spoken_text but can include slightly more detail (safe to scan on a screen).

CHART TEXT FIELDS:
- chart_title: Short, specific title for the chart (e.g. "Daily Steps — Last 7 Days").
- chart_subtitle: One brief phrase explaining the data shown (e.g. "Each bar is one day").
- chart_takeaway: The one pattern worth noticing — phrased as meaning, not a stat.
  ❌ "Steps peaked at 9,200 on Wednesday"
  ✅ "Activity was strongest mid-week and tapered toward the weekend"

SUGGESTED FOLLOWUPS:
- Always include voice commands the user can say, like: "show more", "yes", "go back", "explain that", "what does this mean", "start over".
- When more_available is true: "show more" and "yes" must be in the list.
- Keep phrases short and natural (what someone would actually say to Alexa).

MORE AVAILABLE:
- Set more_available to true when there is at least one more visual stage planned for this question.
- The planner's candidate_stage_types list tells you how many stages are expected (2 to 3 stages total).
- If this is the last stage, set more_available to false.
- When generating the final stage, end spoken_text with 1 sentence summarizing the key health insight from all visuals shown in this session.

HARD RULES:
- Return strict JSON only. No markdown, no prose outside the JSON.
- Do not fabricate data. All numerical insight must come from the pre-built template data.
- Do not provide medical diagnoses or prescriptions.
- Do not generate chart data arrays — the template already has the data.
`.trim();

// Add executorV2 config to AGENT_CONFIGS
AGENT_CONFIGS.executorV2 = {
  version: "phase8-template-fill-v1",
  model: process.env.OPENAI_EXECUTOR_MODEL || process.env.OPENAI_QNA_MODEL || "gpt-4o-mini",
  temperature: asNumber(process.env.OPENAI_EXECUTOR_TEMPERATURE, 0.2),
  // V2 output is much smaller (only text fields, no chart data arrays)
  maxOutputTokens: asNumber(process.env.OPENAI_EXECUTOR_V2_MAX_TOKENS, 500),
  timeoutMs: process.env.OPENAI_EXECUTOR_TIMEOUT_MS != null && process.env.OPENAI_EXECUTOR_TIMEOUT_MS !== ""
    ? asNumber(process.env.OPENAI_EXECUTOR_TIMEOUT_MS, 3600)
    : null,
  systemPrompt: EXECUTOR_SYSTEM_PROMPT_V2,
  textFormat: EXECUTOR_TEXT_FORMAT_V2,
  // V2 does not use tools — chart data comes from backend templates
  maxToolTurns: 0,
  toolPolicy: null,
};

module.exports = {
  AGENT_CONFIGS,
  EXECUTOR_ALLOWED_CHART_TYPES,
  EXECUTOR_READ_TOOLS,
  EXECUTOR_SYSTEM_PROMPT,
  EXECUTOR_SYSTEM_PROMPT_V2,
  EXECUTOR_TEXT_FORMAT,
  EXECUTOR_TEXT_FORMAT_V2,
  EXECUTOR_WRITE_TOOLS,
  PLANNER_ALLOWED_MODES,
  PLANNER_ALLOWED_STAGE_TYPES,
  PLANNER_ALLOWED_TIME_SCOPES,
  PLANNER_SYSTEM_PROMPT,
  PLANNER_TEXT_FORMAT,
};
