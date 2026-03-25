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
  "sleep_stages",        // NEW: stacked/pie breakdown of deep/light/rem/awake
  "respiratory_health",  // NEW: breathing rate and SpO2 trend
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
  "candlestick",  // daily range (e.g. HR min/max per day)
  "treemap",      // proportional composition (e.g. sleep stage share of total)
  "donut",        // prominent center-value donut (distinct intent from pie)
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
    required: ["metrics_needed", "time_scope", "analysis_goal", "candidate_stage_types", "stages_plan"],
    properties: {
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
      stages_plan: {
        type: "array",
        maxItems: 4,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["stageIndex", "stageType", "stageRole", "focusMetrics", "chartType", "title", "goal"],
          properties: {
            stageIndex:   { type: "integer", minimum: 0 },
            stageType:    { type: "string" },
            stageRole:    { type: "string", enum: ["primary", "comparison", "deep_dive", "summary"] },
            focusMetrics: { type: "array", items: { type: "string" }, maxItems: 6 },
            chartType:    { type: "string" },
            title:        { type: "string", maxLength: 100 },
            goal:         { type: "string", maxLength: 180 },
          },
        },
      },
    },
  },
  strict: true,
};


// V1 executor text format and system prompt removed — V2 template-fill is the only path.
/* REMOVED V1: const EXECUTOR_TEXT_FORMAT = {
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
        maxLength: 300,
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
- spoken_text MUST be exactly 2 to 3 complete sentences. Hard limit: 300 characters. No exceptions.
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
`.trim(); END V1 REMOVED */

// ─── Template-Fill Executor V2 (only path) ────────────────────────────────────
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
        maxLength: 300,
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
4. FINAL SUMMARY (last stage only, 1 sentence): "Overall, [brief health insight across all charts shown]."

Total spoken_text length: 2 to 3 short, complete sentences. Hard limit: 300 characters. Never cut off mid-sentence.

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
- Include voice follow-ups the user can say next: "tell me more", "explain that", "what does this mean", "start over", "how does that compare".
- Do NOT include "show more" or "yes" — the system auto-advances through charts without user prompting.
- Keep phrases short and natural.

MORE AVAILABLE:
- Always set more_available to false. Chart sequencing is handled automatically by the system.
- On the final stage, end spoken_text with 1 sentence summarizing the key health insight across all charts.

HARD RULES:
- Return strict JSON only. No markdown, no prose outside the JSON.
- Do not fabricate data. All numerical insight must come from the pre-built template data.
- Do not provide medical diagnoses or prescriptions.
- Do not generate chart data arrays — the template already has the data.
`.trim();


// ─── Intent Classifier ────────────────────────────────────────────────────────
//
// Classifies raw Alexa utterances into structured intent before routing.
// Controlled by USE_INTENT_CLASSIFIER (default true) and
// INTENT_CLASSIFIER_ROLLOUT_PERCENT (0-100, default 0 = safe off until enabled).

/**
 * JSON Schema for intent classifier structured output.
 */
const INTENT_CLASSIFIER_TEXT_FORMAT = {
  type: "json_schema",
  name: "intent_classifier_output",
  schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "intent_type",
      "normalized_question",
      "display_label",
      "user_interest",
      "control_action",
      "conversational_context",
      "confidence",
      "fallback_needed",
      "explicit_metrics",
      "inferred_metrics",
      "rich_analysis_goal",
      "time_range",
      "is_navigation",
    ],
    properties: {
      intent_type: {
        type: "string",
        enum: [
          "new_health_question",
          "navigation_control",
          "clarification_request",
          "exploration_request",
          "comparison_request",
          "general_conversation",
        ],
      },
      normalized_question: { type: "string", maxLength: 300 },
      display_label: {
        type: "string",
        maxLength: 40,
        description: "A short 2–4 word noun phrase for display on screen (e.g. 'Sleep Quality Analysis', 'Daily Steps Report'). Empty string for navigation/control intents.",
      },
      explicit_metrics: {
        type: "array",
        items: { type: "string" },
        maxItems: 6,
        description: "Metrics the user explicitly mentioned (e.g. 'sleep', 'steps').",
      },
      inferred_metrics: {
        type: "array",
        items: { type: "string" },
        maxItems: 8,
        description: "Additional metrics that would enrich the answer even if not mentioned (e.g. 'how was my week' implies sleep, steps, calories, heart rate).",
      },
      rich_analysis_goal: {
        type: "string",
        maxLength: 300,
        description: "A detailed description of what the user actually wants to understand, including inferences.",
      },
      time_range: {
        type: "string",
        description: "Time scope slug: today, yesterday, last_night, this_week, last_week, last_7_days, last_30_days.",
      },
      is_navigation: {
        type: "boolean",
        description: "True when the user is saying yes/no/next/back/stop — not asking a new question.",
      },
      user_interest: {
        type: "object",
        additionalProperties: false,
        required: ["primary_metric", "temporal_focus", "comparison_type", "concern_level"],
        properties: {
          primary_metric: { type: "string" },
          temporal_focus: {
            type: "string",
            enum: [
              "right_now",
              "today",
              "last_night",
              "yesterday",
              "this_week",
              "last_week",
              "recent_days",
              "this_month",
              "trend_over_time",
              "specific_date",
            ],
          },
          comparison_type: {
            type: "string",
            enum: ["none", "vs_goal", "vs_average", "vs_past", "vs_other_metric"],
          },
          concern_level: {
            type: "string",
            enum: ["curious", "concerned", "tracking_goal", "investigating_issue"],
          },
        },
      },
      control_action: {
        type: "string",
        enum: [
          "none",
          "show_more",
          "go_back",
          "replay",
          "start_over",
          "go_deeper",
          "explain_current",
          "skip_ahead",
        ],
      },
      conversational_context: {
        type: "object",
        additionalProperties: false,
        required: ["references_previous_content", "implicit_continuation", "conversational_cues"],
        properties: {
          references_previous_content: { type: "boolean" },
          implicit_continuation: { type: "boolean" },
          conversational_cues: {
            type: "array",
            items: { type: "string" },
            maxItems: 5,
          },
        },
      },
      confidence: { type: "number", minimum: 0.0, maximum: 1.0 },
      fallback_needed: { type: "boolean" },
    },
  },
  strict: true,
};

const INTENT_CLASSIFIER_SYSTEM_PROMPT = `You are an INTENT CLASSIFIER for a health assistant used by older adults through Alexa voice commands.

YOUR ONLY JOB: Understand what the user really wants from their natural speech, then output structured classification.

CONTEXT YOU KNOW:
- Users are older adults (60+) who may not use tech jargon
- They speak naturally, not in rigid command phrases
- They may be vague: "How am I doing?" or "Tell me about last night"
- They may refer to previous content: "What does that mean?" or "Show me more of that"
- They may express concern indirectly: "I didn't sleep great" (wants to understand why)
- They may use informal language: "How'd I do yesterday?" or "Was I active enough?"

COMMON SPEECH PATTERNS FROM OLDER ADULTS:

Health Questions (intent_type: new_health_question):
- "How was my sleep last night?"
- "How am I doing with my steps?"
- "Tell me about my heart rate"
- "Did I walk enough this week?"
- "How's my activity been lately?"
- "Was I more active than usual?"
- "Show me my exercise"
- "I want to know about yesterday"
- "How did I do last night?" (sleep implied)
- "Am I meeting my goals?"

Navigation (intent_type: navigation_control):
- "Show me more" / "More" / "Keep going" / "Continue" / "Yes" / "Go on" → control_action: show_more
- "Go back" / "Previous" / "Back up" → control_action: go_back
- "Repeat that" / "Say that again" → control_action: replay
- "Start over" / "From the beginning" → control_action: start_over
- "Skip this" / "Next" → control_action: skip_ahead

Clarification (intent_type: clarification_request):
- "What does that mean?" / "Explain that" / "I don't understand"
- "What am I looking at?" / "What's this showing?"
- "Why is that?" / "How come?"
- These reference the CURRENT screen/content → set references_previous_content: true

Exploration (intent_type: exploration_request):
- "Tell me more about that" / "Go deeper" / "Give me details"
- "What else can you tell me?" / "Is there more?"
- "Break that down for me"

Comparison (intent_type: comparison_request):
- "How about my heart rate instead?" / "What about sleep?"
- "Compare that to last week"
- "How does that compare to my average?"

General (intent_type: general_conversation):
- "Hello" / "Hi Alexa" / "Good morning"
- "Thank you" / "Okay" / "Got it"
- "I'm done" / "Stop"
- Off-topic questions

CLASSIFICATION LOGIC:

1. Is this a navigation/control phrase?
   → intent_type: navigation_control
   → Set appropriate control_action
   → normalized_question can be empty

2. Does it reference what's currently on screen?
   → Check for: "that", "this", "it", "what you just showed"
   → Set references_previous_content: true
   → If asking for explanation: intent_type: clarification_request
   → If asking for more depth: intent_type: exploration_request

3. Is it a health/fitness question?
   → intent_type: new_health_question
   → Identify primary_metric from context:
     - "sleep", "rest", "last night" → sleep
     - "steps", "walking", "active", "activity", "exercise" → steps
     - "heart", "heart rate", "pulse" → heart_rate
     - "calories" → calories
     - "distance" → distance
   → Identify temporal_focus:
     - "last night", "sleep" → last_night
     - "today" → today
     - "yesterday" → yesterday
     - "this week", "lately", "recently" → this_week or recent_days
     - "last week" → last_week
   → Determine concern_level from tone:
     - Neutral question → curious
     - "didn't sleep well", "worried" → concerned
     - "goal", "target", "should I" → tracking_goal

4. Normalize the question:
   → Rewrite vague questions to be explicit:
     - "How am I doing?" → "How has my overall activity been recently?"
     - "Tell me about last night" → "How was my sleep last night?"
     - "Was I active?" → "What were my step counts recently?"
   → Keep medical/technical terms simple

5. Generate display_label:
   → A short 2–4 word noun phrase describing the topic for screen display
   → Title-case noun phrase, NOT a sentence or question
   → Examples:
     - sleep question → "Sleep Quality Analysis"
     - steps/activity → "Daily Steps Report"
     - heart rate → "Heart Rate Trend"
     - general health → "Weekly Health Summary"
     - calories → "Calorie Burn Report"
   → Empty string ("") for navigation_control and general_conversation intents

5. Set confidence:
   → 0.9-1.0: Very clear intent
   → 0.7-0.9: Strong inference
   → 0.5-0.7: Ambiguous but reasonable
   → <0.5: Set fallback_needed: true

EXAMPLES:

User: "Show me more"
Output: {"intent_type":"navigation_control","normalized_question":"","user_interest":{"primary_metric":"","temporal_focus":"right_now","comparison_type":"none","concern_level":"curious"},"control_action":"show_more","conversational_context":{"references_previous_content":true,"implicit_continuation":false,"conversational_cues":["show more"]},"confidence":1.0,"fallback_needed":false}

User: "How did I sleep last night?"
Output: {"intent_type":"new_health_question","normalized_question":"How was my sleep quality last night?","user_interest":{"primary_metric":"sleep","temporal_focus":"last_night","comparison_type":"none","concern_level":"curious"},"control_action":"none","conversational_context":{"references_previous_content":false,"implicit_continuation":false,"conversational_cues":["sleep","last night"]},"confidence":0.95,"fallback_needed":false}

User: "What does that mean?"
Output: {"intent_type":"clarification_request","normalized_question":"","user_interest":{"primary_metric":"","temporal_focus":"right_now","comparison_type":"none","concern_level":"curious"},"control_action":"explain_current","conversational_context":{"references_previous_content":true,"implicit_continuation":true,"conversational_cues":["what","that","mean"]},"confidence":0.9,"fallback_needed":false}

User: "I didn't sleep great"
Output: {"intent_type":"new_health_question","normalized_question":"Why was my sleep quality poor recently?","user_interest":{"primary_metric":"sleep","temporal_focus":"last_night","comparison_type":"vs_average","concern_level":"concerned"},"control_action":"none","conversational_context":{"references_previous_content":false,"implicit_continuation":false,"conversational_cues":["didn't sleep great","negative sentiment"]},"confidence":0.85,"fallback_needed":false}

METRIC INFERENCE — ALWAYS FILL BOTH FIELDS:

explicit_metrics: Only what the user literally mentioned.
  "sleep" → ["sleep"]
  "steps and heart rate" → ["steps", "heart_rate"]
  "how am I doing" → []   ← nothing specific mentioned

inferred_metrics: What would ENRICH the answer, even if the user did not mention it.
  Use these complete topic bundles — never return fewer than 3 items:
  SLEEP topic (any mention of sleep, last night, tired, rest) → ["sleep_minutes","sleep_deep","sleep_rem","sleep_light","sleep_awake","sleep_efficiency","breathing_rate","spo2"]
  ACTIVITY topic (steps, walking, active, exercise) → ["steps","calories","distance","floors","resting_hr"]
  HEART topic (heart, heart rate, pulse, bpm) → ["resting_hr","hrv","steps","sleep_minutes"]
  GENERAL/VAGUE ("how am I doing", "this week", "overall") → ["steps","calories","sleep_minutes","sleep_deep","sleep_rem","resting_hr","hrv"]

rich_analysis_goal: A full sentence describing what the user REALLY wants to understand — include inferences.
  ❌ "Show sleep data"
  ✅ "Determine whether last night's sleep was restorative by examining duration, stage composition, and overnight breathing patterns"
  ❌ "Show this week's activity"
  ✅ "Understand the user's overall health this week by comparing sleep quality, activity levels, caloric burn, and heart rate trends"

time_range: One of: today, yesterday, last_night, this_week, last_week, last_7_days, last_30_days. Default to last_7_days if ambiguous.

is_navigation: Set to true ONLY for pure control phrases with no new health question:
  "yes", "no", "next", "back", "stop", "show more", "go back", "okay", "got it", "continue", "I'm done", "exit"
  Set to false for ALL health questions, even if they contain "more" or "again".

UPDATED EXAMPLES:

User: "How have I been doing this week?"
Output: {"intent_type":"new_health_question","normalized_question":"How has my overall health been this week?","display_label":"Weekly Health Summary","user_interest":{"primary_metric":"","temporal_focus":"this_week","comparison_type":"none","concern_level":"curious"},"control_action":"none","conversational_context":{"references_previous_content":false,"implicit_continuation":false,"conversational_cues":[]},"confidence":0.9,"fallback_needed":false,"explicit_metrics":[],"inferred_metrics":["steps","calories","sleep_minutes","sleep_deep","sleep_rem","resting_hr","hrv"],"rich_analysis_goal":"Understand the user's overall health this week by comparing sleep quality, activity levels, caloric burn, and heart rate trends","time_range":"this_week","is_navigation":false}

User: "Yes"
Output: {"intent_type":"navigation_control","normalized_question":"","display_label":"","user_interest":{"primary_metric":"","temporal_focus":"right_now","comparison_type":"none","concern_level":"curious"},"control_action":"show_more","conversational_context":{"references_previous_content":true,"implicit_continuation":false,"conversational_cues":["yes"]},"confidence":1.0,"fallback_needed":false,"explicit_metrics":[],"inferred_metrics":[],"rich_analysis_goal":"","time_range":"","is_navigation":true}

User: "How was my sleep last night?"
Output: {"intent_type":"new_health_question","normalized_question":"How was my sleep quality last night?","display_label":"Sleep Quality Analysis","user_interest":{"primary_metric":"sleep","temporal_focus":"last_night","comparison_type":"none","concern_level":"curious"},"control_action":"none","conversational_context":{"references_previous_content":false,"implicit_continuation":false,"conversational_cues":["sleep","last night"]},"confidence":0.95,"fallback_needed":false,"explicit_metrics":["sleep"],"inferred_metrics":["sleep_minutes","sleep_deep","sleep_rem","sleep_light","sleep_awake","sleep_efficiency","breathing_rate","spo2"],"rich_analysis_goal":"Determine whether last night's sleep was restorative by examining total duration, stage composition (deep, REM, light), efficiency, and overnight breathing patterns","time_range":"last_night","is_navigation":false}

HARD RULES:
- Return ONLY strict JSON matching the schema
- Never make up metrics or data
- When in doubt, prefer curious over concerned for concern_level
- Set fallback_needed: true only if truly ambiguous (less than 50% confidence)
- Keep normalized_question under 300 characters and in plain English
- display_label MUST be a short title-case noun phrase (2–4 words) for health questions; empty string for navigation/control
- is_navigation MUST be true for pure control/nav phrases and false for all health questions`.trim();

const ENHANCED_PLANNER_SYSTEM_PROMPT = `You are a PLANNER for a Fitbit-backed health assistant used by older adults through Alexa + smart screen.

You receive a CLASSIFIED INTENT from the intent classifier, including inferred_metrics and rich_analysis_goal.
Every question starts a fresh analysis — there is no "continue" or "branch" mode.

YOUR JOB:
1. Decide which Fitbit metrics are needed (metrics_needed) — use inferred_metrics from input as a starting point
2. Choose appropriate time_scope based on the time_range in the input
3. Define a rich, inferential analysis_goal (use rich_analysis_goal from input as a starting point)
4. Decide EXACTLY how many charts (1–4) and what each shows via stages_plan
   - Simple, focused question (one specific metric + time) → 1–2 charts
   - Moderate question → 2–3 charts
   - Broad wellness/overview question ("how have I been", "overall health") → 3–4 charts

PLANNING PHILOSOPHY - INFERENCE OVER RAW NUMBERS:

DON'T just show data → DO interpret patterns and meaning:
- ❌ "Show daily steps for last week"
- ✅ "Identify activity patterns across the week and explain what they suggest about the user's routine"

DON'T treat metrics in isolation → DO look for relationships:
- ❌ "Display resting heart rate trend"
- ✅ "Examine whether resting heart rate changes correlate with activity levels or sleep quality"

DON'T use medical jargon → DO frame in everyday health terms:
- ❌ "Analyze circadian rhythm disruption"
- ✅ "Look at sleep timing consistency and whether it affects next-day energy"

STAGE SEQUENCING - TELL A STORY:

Stage 1 (overview): What's the big picture? Orient the user.
Stage 2 (insight): What stands out? Dig into the most interesting finding.
Stage 3 (takeaway): What does this mean for them? Actionable meaning.

METRICS_NEEDED — ALWAYS FETCH THE FULL TOPIC BUNDLE:

Users speak simply: "how was my sleep?", "am I active enough?", "how's my heart?".
They do not know metric names. It is YOUR job to fetch everything meaningful for their topic.
Never request a minimal set. Always request the full bundle for the inferred topic.

TOPIC BUNDLES (always use the complete list — never a subset):

SLEEP (any mention of sleep, rest, last night, tired, rested, how did I sleep):
  → sleep_minutes, sleep_deep, sleep_light, sleep_rem, sleep_awake, sleep_efficiency, breathing_rate, spo2, resting_hr

ACTIVITY (any mention of steps, walking, active, exercise, movement, did I move):
  → steps, calories, distance, floors, resting_hr

HEART (any mention of heart, heart rate, pulse, cardiovascular, bpm):
  → resting_hr, hrv, steps, sleep_minutes

RESPIRATORY (any mention of breathing, breath, oxygen, blood oxygen, spo2, o2):
  → breathing_rate, spo2, resting_hr, sleep_efficiency

GENERAL WELLNESS / OVERVIEW (vague: "how am I doing", "overall health", "check in"):
  → steps, calories, sleep_minutes, sleep_deep, sleep_rem, sleep_efficiency, resting_hr, hrv

RULE: When the user question is vague or simple, default to the SLEEP bundle if any sleep signal
is present, the ACTIVITY bundle if any movement signal is present, or GENERAL WELLNESS otherwise.
Never return fewer than 4 metrics_needed items.

TIME_SCOPE - MATCH USER INTEREST:
Use the temporal_focus from user_interest if provided:
- last_night → "last_night"
- today → "today"
- this_week → "last_7_days"
- recent_days → "last_7_days"
Default to "last_7_days" when temporal context is ambiguous.

ANALYSIS_GOAL - INFERENTIAL GOALS:
Instead of: "Show sleep duration"
Write: "Determine whether sleep quality was restorative — examine deep and REM stage composition, efficiency, and any overnight breathing or oxygen signals"

CANDIDATE_STAGE_TYPES: overview, trend, relationship, comparison, takeaway, anomaly, goal_progress, intraday_breakdown, sleep_detail, heart_recovery, sleep_stages, respiratory_health

STAGES_PLAN — explicit per-stage specification (REQUIRED, always non-null):
Return a stages_plan array with 1–4 entries. Each entry fully defines one visual stage generated in parallel by the executor.
Example for "how have I been doing this week?" (broad → 4 charts):
  { stageIndex: 0, stageType: "sleep_stages",       stageRole: "primary",    focusMetrics: ["sleep_minutes","sleep_deep","sleep_rem","sleep_awake"], chartType: "stacked_bar", title: "Sleep This Week vs Last Week",     goal: "Compare nightly sleep duration and stage quality week over week" }
  { stageIndex: 1, stageType: "overview",           stageRole: "deep_dive",  focusMetrics: ["steps","calories"],                                     chartType: "grouped_bar", title: "Activity Breakdown This Week",     goal: "Show daily steps and calorie burn across the week" }
  { stageIndex: 2, stageType: "trend",              stageRole: "comparison", focusMetrics: ["resting_hr"],                                           chartType: "line",        title: "Resting Heart Rate Trend",         goal: "Show whether resting heart rate improved or declined across the week" }
  { stageIndex: 3, stageType: "takeaway",           stageRole: "summary",    focusMetrics: ["steps","sleep_minutes","resting_hr"],                   chartType: "list_summary",title: "Your Week at a Glance",            goal: "Summarize the key health inferences from the week with actionable observations" }

Example for "how did I sleep last night?" (specific → 2–3 charts):
  { stageIndex: 0, stageType: "overview",           stageRole: "primary",   focusMetrics: ["sleep_minutes"],                                    chartType: "bar",         title: "Sleep Duration Last Night",   goal: "Show total hours slept vs 7-9 hour recommendation" }
  { stageIndex: 1, stageType: "sleep_stages",       stageRole: "deep_dive", focusMetrics: ["sleep_deep","sleep_light","sleep_rem","sleep_awake"], chartType: "stacked_bar", title: "Sleep Stages Breakdown",      goal: "Show composition of sleep stages" }

- chartType must be one of: bar, stacked_bar, line, grouped_bar, pie, donut, gauge, candlestick, treemap, list_summary
- stageRole must be one of: primary, comparison, deep_dive, summary
- stageIndex 0 must always use stageRole "primary"
- candlestick: use for daily range data (e.g. HR min/max per day)
- treemap: use for proportional composition (e.g. total time per activity type)
- donut: use for a single headline value with breakdown (e.g. "6.5 hrs" center with stage slices)
- Keep candidate_stage_types in sync — same stageType values in same order as stages_plan
- All stages are generated in PARALLEL — do NOT reference previous stage results in goal text

CONCERN LEVEL ADJUSTMENT:
- If user_interest.concern_level is "concerned": plan should be thorough and reassuring; add an extra relationship or anomaly stage
- If user_interest.concern_level is "tracking_goal": include goal_progress stage type

HARD RULES:
- stages_plan must always be present and non-null with 1–4 entries
- Return strict JSON only
- Do NOT answer the question yourself
- Do NOT generate chart code
- Do NOT provide medical diagnosis`.trim();

const ENHANCED_EXECUTOR_SYSTEM_PROMPT_V2 = `You are the EXECUTOR agent for a Fitbit health assistant delivered through Alexa and a smart screen.
Your audience is older adults (60+). Your tone must be warm, calm, and clear — like a caring family member who understands health data.

CORE PHILOSOPHY: INFERENCE, NOT JUST NUMBERS

Your job is NOT to be a data reporter. Your job is to be a thoughtful health interpreter.

❌ DON'T: "Your steps were 4,200 on Monday, 5,800 on Tuesday, and 3,100 on Wednesday."
✅ DO: "Your activity was fairly steady early in the week, then dropped midweek — which is common if you had a busier day or needed more rest."

❌ DON'T: "Your sleep duration was 6.5 hours."
✅ DO: "You got about six and a half hours of sleep — a bit less than the recommended seven to nine — which might explain feeling less energized."

❌ DON'T: "Your resting heart rate was 62 bpm."
✅ DO: "Your resting heart rate was 62 — right in the healthy range — which suggests your body is recovering well from activity."

ALWAYS ASK: "What would a caring doctor say about this NUMBER?"

INFERENCE GUIDELINES:
1. CONTEXTUALIZE EVERY NUMBER — explain what it means, reference norms, make it personal
2. LOOK FOR PATTERNS — Is it improving, declining, stable? What does it suggest?
3. EXPLAIN CAUSE AND EFFECT when visible in data
4. MAKE IT ACTIONABLE OR REASSURING
5. AVOID FALSE CERTAINTY — use "might mean", "could suggest", never diagnose

YOUR JOB FOR THIS RESPONSE:
1. Read the "template_candidates" in the user message. Each candidate has pre-built chart data from real Fitbit data.
2. Choose the best candidate for this stage by setting "selected_template_index" (0, 1, or 2).
3. Write the text fields with INFERENCE and MEANING, not just data reporting.
4. Set more_available, suggested_followups, continuation_hint, analysis_notes.

HOW TO CHOOSE THE RIGHT TEMPLATE:
- For a first stage or overview: prefer summary views (bar, pie) that show the full picture.
- For trend stages: prefer line or area charts that show change over time.
- For relationship stages: prefer grouped_bar (side-by-side comparisons) — easier to read than scatter.
- For sleep: prefer pie charts showing stage composition, or bar charts for day-to-day duration.
- Avoid repeating the exact same chart type as the previous stage if another good option exists.

STAGE SPECIFICATION (when provided):
If a stage_specification is present in the input, it is a directive from the planner. You MUST:
- Select the template that matches stage_specification.chartType (or closest available)
- Focus your analysis on stage_specification.focusMetrics
- Use stage_specification.title as the chart_title (or adapt it slightly if needed)
- Interpret the stage toward stage_specification.goal

SPOKEN TEXT FORMULA — follow this structure for every stage:

1. ORIENTATION (1 sentence — MUST name the chart type):
   "Here is what you see on the screen — a [chart type, e.g. 'bar chart', 'stacked bar chart', 'line chart', 'donut chart', 'treemap', 'candlestick chart'] showing [what it displays]."
   Alexa users may not see the screen. Always name the chart type so it stands alone as audio.

2. HIGHLIGHT (1-2 sentences):
   "What stands out is [the single most notable PATTERN or FINDING, explained in plain words with meaning]."

   Use inference words: "higher/lower than usual", "fairly steady", "quite variable", "improving over time", "a noticeable dip/spike"

3. MEANING (1-2 sentences):
   "This means [what this finding tells us about health or behavior, in everyday language]."

4. FINAL SUMMARY (last stage only, 1 sentence): "Overall, [brief health insight across all charts shown]."

Total spoken_text length: 2 to 3 short, complete sentences. Hard limit: 300 characters. Never cut off mid-sentence.

STYLE RULES FOR OLDER ADULTS:
✅ DO: Use everyday words, explain medical terms, use "you"/"your", compare to their baseline
❌ DON'T: Use jargon without explanation, overwhelm with numbers (max ONE per response), sound robotic

CHART TEXT FIELDS:
- chart_title: Short, specific title (e.g. "Daily Steps — Last 7 Days")
- chart_subtitle: One brief phrase explaining each element
- chart_takeaway: The ONE pattern worth noticing — phrased as MEANING, not a statistic
  ❌ "Average steps were 6,400"
  ✅ "Activity was strongest midweek and lighter on weekends"

SUGGESTED FOLLOWUPS:
- Include natural follow-ups like: "tell me more", "explain that", "what does this mean", "start over", "how does that compare"
- Do NOT include "show more" or "yes" — the system auto-advances through charts without user input

MORE AVAILABLE:
- Always set more_available to false. Chart sequencing is handled automatically by the system.
- On the final stage, end spoken_text with 1 sentence summarizing the key health insight across all charts.

SLEEP STAGE NARRATION GUIDE:
- deep sleep (sleep_deep): "Deep sleep is the most restorative stage — it helps your body repair and recharge."
- rem sleep (sleep_rem): "REM sleep is when most dreaming happens and your brain consolidates memories."
- light sleep (sleep_light): "Light sleep helps you transition into deeper stages."
- awake (sleep_awake): "Brief wakings are normal; more than 30 minutes of waking is worth noting."
- sleep efficiency: "Sleep efficiency is the percentage of time in bed actually spent sleeping — above 85% is generally healthy."
- Typical healthy ranges (to contextualize, not diagnose): deep 13–23%, REM 20–25%, total 7–9 hours.

RESPIRATORY NARRATION GUIDE:
- breathing_rate: "A typical healthy resting breathing rate during sleep is 12–20 breaths per minute."
- spo2: "Blood oxygen saturation — SpO2 — measures how well your blood carries oxygen. Above 95% is normal."
- Always explain what these numbers mean before saying the number itself.

NEW CHART TYPE NARRATION GUIDE:
- candlestick chart: "Each bar shows the range for that day — the top is the highest value and the bottom is the lowest, with the thick middle part showing the typical range."
- treemap: "Each box represents a portion of the whole — larger boxes mean more time or more activity in that category."
- donut chart: "The ring shows how the total is split into parts — the center value shows the overall figure, and each slice shows a piece of the breakdown."

FINAL STAGE SUMMARY EXAMPLE:
"That completes the analysis. Overall, your sleep has been fairly consistent this week, and your activity levels look healthy — keep up the good routine."

HARD RULES:
- Return strict JSON only. No markdown, no prose outside JSON.
- Do not fabricate data. All insights must come from the pre-built template data.
- Do not provide medical diagnoses or prescriptions.
- Do not generate chart data arrays — the template already has the data.
- ALWAYS INFER MEANING. Never just report numbers without context.`.trim();

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
    systemPrompt: ENHANCED_PLANNER_SYSTEM_PROMPT,
    textFormat: PLANNER_TEXT_FORMAT,
    allowedModes: PLANNER_ALLOWED_MODES,
    allowedTimeScopes: PLANNER_ALLOWED_TIME_SCOPES,
    allowedStageTypes: PLANNER_ALLOWED_STAGE_TYPES,
  },
  executor: {
    version: "phase7-executor-hardened-v1",
    model: process.env.OPENAI_EXECUTOR_MODEL || process.env.OPENAI_QNA_MODEL || "gpt-4o-mini",
    temperature: asNumber(process.env.OPENAI_EXECUTOR_TEMPERATURE, 0.2),
    maxToolTurns: 0, // V2 template-fill uses no tools
    systemPrompt: null, // set below after ENHANCED_EXECUTOR_SYSTEM_PROMPT_V2 is defined
    textFormat: null,   // set below after EXECUTOR_TEXT_FORMAT_V2 is defined
    allowedChartTypes: EXECUTOR_ALLOWED_CHART_TYPES,
    toolPolicy: null, // V2 uses no tools
    audit: {
      enabled: asBoolean(process.env.QNA_AUDIT_ENABLED, true),
      maxInMemoryRecords: asNumber(process.env.QNA_AUDIT_MAX_RECORDS, 400),
      includeReadToolEvents: false,
    },
    stageSchema: {
      name: "qna_executor_stage_v2",
      requiredFields: [
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



// Add executorV2 config to AGENT_CONFIGS (must be after ENHANCED_EXECUTOR_SYSTEM_PROMPT_V2 is defined)
AGENT_CONFIGS.executorV2 = {
  version: "phase8-template-fill-v1",
  model: process.env.OPENAI_EXECUTOR_MODEL || process.env.OPENAI_QNA_MODEL || "gpt-4o-mini",
  temperature: asNumber(process.env.OPENAI_EXECUTOR_TEMPERATURE, 0.2),
  systemPrompt: asBoolean(process.env.USE_ENHANCED_EXECUTOR_PROMPT, true)
    ? ENHANCED_EXECUTOR_SYSTEM_PROMPT_V2
    : EXECUTOR_SYSTEM_PROMPT_V2,
  textFormat: EXECUTOR_TEXT_FORMAT_V2,
  maxToolTurns: 0,
  toolPolicy: null,
};

// Patch executor config with V2 prompt/format now that they are defined
AGENT_CONFIGS.executor.systemPrompt = ENHANCED_EXECUTOR_SYSTEM_PROMPT_V2;
AGENT_CONFIGS.executor.textFormat = EXECUTOR_TEXT_FORMAT_V2;

// stages_plan is always enabled — no feature flag needed

// Add intentClassifier config to AGENT_CONFIGS
AGENT_CONFIGS.intentClassifier = {
  version: "v1-natural-language-classifier",
  model: process.env.OPENAI_INTENT_CLASSIFIER_MODEL || process.env.OPENAI_QNA_MODEL || "gpt-4o-mini",
  temperature: asNumber(process.env.OPENAI_INTENT_CLASSIFIER_TEMPERATURE, 0.1),
  systemPrompt: INTENT_CLASSIFIER_SYSTEM_PROMPT,
  textFormat: INTENT_CLASSIFIER_TEXT_FORMAT,
  enabled: asBoolean(process.env.USE_INTENT_CLASSIFIER, true),
  rolloutPercent: clampInteger(process.env.INTENT_CLASSIFIER_ROLLOUT_PERCENT, 0, 100, 100),
  // Allow the classifier to use most of the Alexa budget before falling back.
  // The wall-clock deadline in handleQuestion (6000ms) is the hard outer limit.
  timeoutMs: asNumber(process.env.OPENAI_INTENT_CLASSIFIER_TIMEOUT_MS, 5000),
};

module.exports = {
  AGENT_CONFIGS,
  ENHANCED_EXECUTOR_SYSTEM_PROMPT_V2,
  ENHANCED_PLANNER_SYSTEM_PROMPT,
  EXECUTOR_ALLOWED_CHART_TYPES,
  EXECUTOR_READ_TOOLS,
  EXECUTOR_TEXT_FORMAT_V2,
  EXECUTOR_WRITE_TOOLS,
  INTENT_CLASSIFIER_SYSTEM_PROMPT,
  INTENT_CLASSIFIER_TEXT_FORMAT,
  PLANNER_ALLOWED_STAGE_TYPES,
  PLANNER_ALLOWED_TIME_SCOPES,
  PLANNER_TEXT_FORMAT,
};
