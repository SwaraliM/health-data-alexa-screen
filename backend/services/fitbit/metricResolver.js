/**
 * backend/services/fitbit/metricResolver.js
 *
 * Phase 1 deterministic metric resolver.
 * - Maps planner/user language to canonical metric keys.
 * - Keeps logic simple and explicit (no GPT calls, no probabilistic behavior).
 * TODO(phase2): Move concept mappings into shared agent config for planner/executor parity.
 */

const RESOLVER_DEBUG = process.env.FITBIT_METRIC_RESOLVER_DEBUG !== "false";

function resolverLog(message, data = null) {
  if (!RESOLVER_DEBUG) return;
  if (data == null) return console.log(`[MetricResolver] ${message}`);
  console.log(`[MetricResolver] ${message}`, data);
}

const CANONICAL_METRICS = new Set([
  "steps",
  "calories",
  "distance",
  "floors",
  "elevation",
  "sleep_minutes",
  "resting_hr",
  "hrv",
  "heart_intraday",
  "steps_intraday",
  "calories_intraday",
  "distance_intraday",
  "floors_intraday",
  // NEW: sleep stage metrics
  "sleep_deep",
  "sleep_light",
  "sleep_rem",
  "sleep_awake",
  "sleep_efficiency",
  // NEW: respiratory metrics
  "breathing_rate",
  "spo2",
]);

const METRIC_ALIASES = {
  steps: ["steps", "step count", "walking", "walk", "movement"],
  calories: ["calories", "calorie burn", "burn", "energy burned"],
  distance: ["distance", "miles", "kilometers", "km"],
  floors: ["floors", "stairs", "flights climbed"],
  elevation: ["elevation", "elevation gain", "climb"],
  sleep_minutes: ["sleep", "sleep duration", "time asleep", "sleep time"],
  resting_hr: ["resting hr", "resting heart rate", "rhr"],
  hrv: ["hrv", "heart rate variability"],
  heart_intraday: ["heart today by hour", "heart rate today by hour", "hourly heart rate", "heart intraday"],
  steps_intraday: ["steps today by hour", "hourly steps", "activity today by hour", "steps intraday"],
  calories_intraday: ["calories today by hour", "hourly calories", "calories intraday"],
  distance_intraday: ["distance today by hour", "hourly distance", "distance intraday"],
  floors_intraday: ["floors today by hour", "hourly floors", "floors intraday"],
  // NEW: sleep stage aliases
  sleep_deep: ["deep sleep", "slow wave sleep", "deep sleep minutes"],
  sleep_light: ["light sleep", "light sleep minutes"],
  sleep_rem: ["rem sleep", "rem", "dream sleep", "dreaming", "rem sleep minutes"],
  sleep_awake: ["wake", "awake during sleep", "night wakings", "times awake"],
  sleep_efficiency: ["sleep efficiency", "sleep quality score", "sleep score"],
  // NEW: respiratory aliases
  breathing_rate: ["breathing rate", "breathing", "respiration", "respiration rate", "breaths per minute"],
  spo2: ["spo2", "blood oxygen", "oxygen saturation", "o2 levels", "oxygen levels", "blood o2"],
};

const CONCEPT_TO_METRICS = {
  energy: ["steps"],
  "heart health": ["resting_hr", "hrv"],
  "physical activity": ["steps", "calories", "distance"],
  "activity today by hour": ["steps_intraday"],
  // NEW: sleep and respiratory concepts
  "sleep quality": ["sleep_deep", "sleep_rem", "sleep_efficiency"],
  "sleep stages": ["sleep_deep", "sleep_light", "sleep_rem", "sleep_awake"],
  "sleep breakdown": ["sleep_deep", "sleep_light", "sleep_rem", "sleep_awake"],
  "respiratory health": ["breathing_rate", "spo2"],
  "overnight health": ["sleep_minutes", "sleep_efficiency", "breathing_rate", "spo2", "resting_hr"],
};

const DOMAIN_METRIC_BUNDLES = {
  sleep: ["sleep_minutes", "sleep_efficiency", "sleep_deep", "sleep_rem", "sleep_awake", "resting_hr"],
  activity: ["steps", "calories", "distance", "floors", "resting_hr"],
  "heart health": ["resting_hr", "hrv", "sleep_minutes", "steps"],
  "overall health": ["steps", "calories", "sleep_minutes", "sleep_efficiency", "sleep_deep", "resting_hr", "hrv"],
};

function normalizeText(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function pushUnique(target, values) {
  (Array.isArray(values) ? values : [values]).forEach((value) => {
    const metric = normalizeText(value);
    if (!metric) return;
    if (!target.includes(metric)) target.push(metric);
  });
}

function aliasToMetricMap() {
  const map = new Map();
  Object.entries(METRIC_ALIASES).forEach(([metric, aliases]) => {
    aliases.forEach((alias) => map.set(normalizeText(alias), metric));
  });
  return map;
}

const ALIAS_LOOKUP = aliasToMetricMap();

function expandConceptToMetrics(concept) {
  const normalizedConcept = normalizeText(concept);
  if (!normalizedConcept) return [];

  if (CONCEPT_TO_METRICS[normalizedConcept]) {
    return [...CONCEPT_TO_METRICS[normalizedConcept]];
  }

  // Lightweight substring matching for common planner phrases.
  const match = Object.entries(CONCEPT_TO_METRICS).find(([key]) => normalizedConcept.includes(key));
  return match ? [...match[1]] : [];
}

function resolveSingleToken(token) {
  const normalized = normalizeText(token);
  if (!normalized) return [];

  if (CANONICAL_METRICS.has(normalized)) return [normalized];
  if (ALIAS_LOOKUP.has(normalized)) return [ALIAS_LOOKUP.get(normalized)];

  const conceptExpansion = expandConceptToMetrics(normalized);
  if (conceptExpansion.length) return conceptExpansion;

  return [];
}

function resolveMetricAliases(inputMetrics) {
  const tokens = Array.isArray(inputMetrics) ? inputMetrics : [inputMetrics];
  const resolved = [];

  tokens.forEach((token) => {
    if (token == null) return;

    // Support comma-separated metric requests in one string.
    const parts = typeof token === "string" ? token.split(",") : [token];
    parts.forEach((part) => {
      const metrics = resolveSingleToken(part);
      pushUnique(resolved, metrics);
    });
  });

  resolverLog("metric aliases resolved", {
    inputCount: tokens.length,
    resolved,
  });
  return resolved;
}

function collectCandidateInputs(input) {
  if (input == null) return [];
  if (Array.isArray(input) || typeof input === "string") return [input];
  if (typeof input !== "object") return [];

  const candidates = [];
  const fields = [
    "metricsRequested",
    "metrics_requested",
    "metrics_needed",
    "metrics",
    "metric",
    "concept",
    "concepts",
    "analysis_goal",
    "question",
  ];

  fields.forEach((field) => {
    if (input[field] == null) return;
    candidates.push(input[field]);
  });

  return candidates;
}

function resolveRequestedMetrics(input) {
  const candidates = collectCandidateInputs(input);
  const resolved = [];

  candidates.forEach((candidate) => {
    const metrics = resolveMetricAliases(candidate);
    pushUnique(resolved, metrics);
  });

  // Conservative fallback for Phase 1 when planner/user input is empty.
  if (!resolved.length) resolved.push("steps");

  resolverLog("requested metrics resolved", {
    candidates: candidates.length,
    resolved,
  });
  return resolved;
}

function expandMetricSetForQuestion(question = "", metrics = []) {
  const normalizedQuestion = normalizeText(question);
  const expanded = [];
  pushUnique(expanded, Array.isArray(metrics) ? metrics : [metrics]);

  const includes = (pattern) => pattern.test(normalizedQuestion);
  const addBundle = (name) => pushUnique(expanded, DOMAIN_METRIC_BUNDLES[name] || []);
  const metricSet = new Set(expanded);

  const isEvaluative = /\b(has|have|had|is|am|are|was|were|improv|better|worse|normal|enough|declin|increase|decrease|changed)\b/.test(normalizedQuestion);
  const isBroadSleepQuestion = includes(/\b(sleep|slept|sleeping|sleep quality|sleep stages|rest)\b/);
  const isBroadActivityQuestion = includes(/\b(activity|active|steps|walking|exercise|move)\b/);
  const isBroadHeartQuestion = includes(/\b(heart|hrv|resting heart|pulse|recovery)\b/);
  const isOverallHealthQuestion = includes(/\b(overall health|health report|how am i doing|wellness|summary of my health)\b/);

  if (isBroadSleepQuestion && (isEvaluative || metricSet.has("sleep_minutes"))) {
    addBundle("sleep");
  }
  if (isBroadActivityQuestion && (isEvaluative || metricSet.has("steps"))) {
    addBundle("activity");
  }
  if (isBroadHeartQuestion) {
    addBundle("heart health");
  }
  if (isOverallHealthQuestion) {
    addBundle("overall health");
  }

  return expanded;
}

module.exports = {
  resolveMetricAliases,
  expandConceptToMetrics,
  expandMetricSetForQuestion,
  resolveRequestedMetrics,
  CANONICAL_METRICS,
  CONCEPT_TO_METRICS,
};
