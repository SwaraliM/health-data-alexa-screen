/**
 * backend/services/fitbit/syntheticFitbit.js
 *
 * Deterministic, realistic synthetic Fitbit data used to GAP-FILL missing days.
 *
 * Why this exists:
 *   Fitbit migrated to Google Health and some metrics (notably sleep + HRV) stopped
 *   returning data for certain date windows. To keep the demo / QnA / charts working,
 *   this module fills ONLY the gaps (absent or empty/zero days) with values that match
 *   the user's real historical patterns. Real entries are never overwritten.
 *
 * Modeling source:
 *   All baked-in distribution parameters below were computed from amy's REAL data
 *   window 2026-03-23 .. 2026-05-10 (sleep stage summaries, HRV dailyRmssd, breathing
 *   rate, SpO2, resting HR, and the activity series). See plan/commit for the analysis.
 *
 * Output shape:
 *   Every generator returns the EXACT raw Fitbit JSON shape that
 *   backend/services/fitbit/endpointAdapters.js already parses, so nothing downstream
 *   changes.
 *
 * Mode: hardcoded gap-fill ("fill"). Real data always wins.
 */

const SYNTHETIC_MODE = "fill"; // gap-fill only; hardcoded on for the demo.

/** -------------------------------------------------------------------------
 * Deterministic RNG (so the same user+date always yields the same values —
 * stable charts, consistent "yesterday").
 * ---------------------------------------------------------------------- */
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rngFor(seedStr) {
  return mulberry32(hashStr(seedStr));
}

/** Standard-normal sample via Box–Muller, scaled to mean/sd. */
function gauss(rng, mean, sd) {
  const u1 = Math.max(1e-9, rng());
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * sd;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** A coupled "vitality" factor in ~[-1, 1] shared across a day's metrics so that
 *  better-recovery days line up (higher HRV + sleep, lower resting HR). */
function vitalityFactor(username, dateStr) {
  const r = rngFor(`${username}|${dateStr}|vitality`);
  return clamp(gauss(r, 0, 0.5), -1, 1);
}

/** -------------------------------------------------------------------------
 * Baked-in parameters derived from amy's real 2026-03-23..2026-05-10 window.
 * ---------------------------------------------------------------------- */
const SLEEP = {
  meanAsleep: 423,
  sdAsleep: 55,
  minAsleep: 330,
  maxAsleep: 540,
  // weekday multipliers (Sun..Sat) relative to overall mean (Fri longest, Thu shortest)
  weekdayMult: [0.98, 1.01, 1.02, 0.98, 0.88, 1.13, 0.995],
  // fractions of asleep minutes (deep + light + rem == minutesAsleep)
  deepFrac: 0.175,
  lightFrac: 0.6,
  remFrac: 0.225,
  wakeMean: 45,
  wakeSd: 22,
  wakeMin: 10,
  wakeMax: 120,
  effMean: 90,
  effSd: 5,
  effMin: 80,
  effMax: 98,
};
const HRV = { mean: 91, sd: 18, min: 29, max: 119, deepRatio: 0.8 };
const BR = { mean: 15.0, sd: 1.0, min: 12.8, max: 18.2 };
const SPO2 = { mean: 94.5, sd: 1.1, min: 92, max: 97 };
const RHR = { mean: 59.5, sd: 1.5, min: 55, max: 63 };
const STEPS = {
  weekday: [5257, 7623, 8824, 4685, 7937, 4784, 5858], // Sun..Sat
  sd: 2400,
  min: 1200,
  max: 14000,
};
const CAL = { base: 1450, perStep: 0.072, sd: 150, min: 1460, max: 2600 };
const DIST_PER_STEP = 0.000623; // miles per step (from real ratio)
const FLOORS = { mean: 9, sd: 6, min: 2, max: 28 };
const ELEV_PER_FLOOR = 3.0; // feet per floor (from real ratio)

// Active Zone Minutes — derived from amy's real window: median 9, mean 22, heavily
// right-skewed (occasional spikes to ~236), fat-burn dominant, cardio occasional, peak rare.
const AZM = { lnMean: 2.2, lnSd: 0.85, min: 1, max: 240 };

// Named exercise sessions — derived from amy's REAL logged sessions (Mar 23–May 10):
// only Walk (59%) and HIIT (41%) have real data, so ONLY these two real types are used.
// Per-day: ~30% of days are active; on active days 1–8 sessions (avg ~3), weekend-skewed.
const EXERCISE_TYPES = [
  // Walk: real ~22min, ~94cal, ~0.8mi, ~1416 steps per session
  { name: "Walk", activityId: 90013, weight: 0.59, durMean: 21.6, durSd: 8, durMin: 6, durMax: 48, calPerMin: 4.35, stepsPerMin: 65, milesPerMin: 0.037, hasDistance: true },
  // HIIT: real ~5min, ~25cal, no distance, ~125 steps per session
  { name: "HIIT", activityId: 91040, weight: 0.41, durMean: 4.9, durSd: 1.3, durMin: 3, durMax: 8, calPerMin: 5.0, stepsPerMin: 25, milesPerMin: 0, hasDistance: false },
];
// P(active day) by weekday (Sun..Sat) from real data.
const EXERCISE_ACTIVE_PROB = [0.43, 0.43, 0.29, 0.14, 0.14, 0.43, 0.57];

/** -------------------------------------------------------------------------
 * Date helpers
 * ---------------------------------------------------------------------- */
function toDate(str) {
  return new Date(`${str}T12:00:00`);
}
function fmt(d) {
  return d.toISOString().slice(0, 10);
}
function dow(dateStr) {
  return toDate(dateStr).getDay(); // 0=Sun
}
function eachDate(startDate, endDate) {
  const out = [];
  let d = toDate(startDate);
  const end = toDate(endDate);
  while (d <= end) {
    out.push(fmt(d));
    d = new Date(d.getTime() + 86400000);
  }
  return out;
}

/** period like "7d" / "30d" / "1w" / "1m" / "1d" → [startDate, endDate] ending on `date`. */
function periodToRange(date, period) {
  const map = { "1d": 1, "7d": 7, "30d": 30, "1w": 7, "1m": 30, "3m": 90, "6m": 180, "1y": 365 };
  const days = map[period] || 7;
  const end = toDate(date);
  const start = new Date(end.getTime() - (days - 1) * 86400000);
  return [fmt(start), fmt(end)];
}

/** -------------------------------------------------------------------------
 * Per-metric daily synthetic values
 * ---------------------------------------------------------------------- */
function synthSleep(username, dateStr) {
  const v = vitalityFactor(username, dateStr);
  const r = rngFor(`${username}|${dateStr}|sleep`);
  const wkMult = SLEEP.weekdayMult[dow(dateStr)];
  let asleep = gauss(r, SLEEP.meanAsleep * wkMult + v * 25, SLEEP.sdAsleep);
  asleep = Math.round(clamp(asleep, SLEEP.minAsleep, SLEEP.maxAsleep));

  // split asleep into stages with mild per-day jitter
  const deepJit = SLEEP.deepFrac + gauss(r, 0, 0.02) + v * 0.015;
  const remJit = SLEEP.remFrac + gauss(r, 0, 0.02);
  let deep = Math.round(asleep * clamp(deepJit, 0.1, 0.24));
  let rem = Math.round(asleep * clamp(remJit, 0.14, 0.28));
  let light = asleep - deep - rem;
  if (light < 0) {
    light = Math.round(asleep * SLEEP.lightFrac);
    deep = Math.round(asleep * SLEEP.deepFrac);
    rem = asleep - deep - light;
  }
  let wake = Math.round(clamp(gauss(r, SLEEP.wakeMean - v * 10, SLEEP.wakeSd), SLEEP.wakeMin, SLEEP.wakeMax));
  const timeInBed = asleep + wake;
  let efficiency = Math.round(clamp(gauss(r, SLEEP.effMean + v * 3, SLEEP.effSd), SLEEP.effMin, SLEEP.effMax));

  // bedtime ~23:00 (+/- ~45min) on the prior calendar day; wake = bedtime + timeInBed.
  // Fitbit returns naive local timestamps (no timezone), so build them manually.
  const bedMin = Math.round(clamp(gauss(r, 23 * 60, 45), 21 * 60, 25 * 60)); // minutes from prior midnight
  const prevMidnight = new Date(toDate(dateStr).getTime() - 86400000);
  prevMidnight.setHours(0, 0, 0, 0);
  const startMs = prevMidnight.getTime() + bedMin * 60000;
  const naiveIso = (ms) => {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00.000`;
  };
  const startIso = naiveIso(startMs);
  const endIso = naiveIso(startMs + timeInBed * 60000);

  return {
    dateOfSleep: dateStr,
    duration: timeInBed * 60000,
    efficiency,
    startTime: startIso,
    endTime: endIso,
    infoCode: 0,
    isMainSleep: true,
    minutesAsleep: asleep,
    minutesAwake: wake,
    minutesToFallAsleep: 0,
    minutesAfterWakeup: 0,
    timeInBed,
    logType: "stages",
    type: "stages",
    levels: {
      summary: {
        deep: { count: Math.max(1, Math.round(deep / 22)), minutes: deep, thirtyDayAvgMinutes: 74 },
        light: { count: Math.max(1, Math.round(light / 24)), minutes: light, thirtyDayAvgMinutes: 253 },
        rem: { count: Math.max(1, Math.round(rem / 24)), minutes: rem, thirtyDayAvgMinutes: 95 },
        wake: { count: Math.max(1, Math.round(wake / 6)), minutes: wake, thirtyDayAvgMinutes: 47 },
      },
    },
    _synthetic: true,
  };
}

function synthHrv(username, dateStr) {
  const v = vitalityFactor(username, dateStr);
  const r = rngFor(`${username}|${dateStr}|hrv`);
  const daily = +clamp(gauss(r, HRV.mean + v * 12, HRV.sd), HRV.min, HRV.max).toFixed(1);
  const deep = +clamp(daily * HRV.deepRatio + gauss(r, 0, 6), 20, 110).toFixed(1);
  return { dateTime: dateStr, value: { dailyRmssd: daily, deepRmssd: deep }, _synthetic: true };
}

function synthBr(username, dateStr) {
  const r = rngFor(`${username}|${dateStr}|br`);
  const br = +clamp(gauss(r, BR.mean, BR.sd), BR.min, BR.max).toFixed(1);
  return { dateTime: dateStr, value: { breathingRate: br }, _synthetic: true };
}

function synthSpo2(username, dateStr) {
  const r = rngFor(`${username}|${dateStr}|spo2`);
  const avg = +clamp(gauss(r, SPO2.mean, SPO2.sd), SPO2.min, SPO2.max).toFixed(1);
  return {
    dateTime: dateStr,
    value: {
      avg,
      min: +clamp(avg - 1.5 - rng01(r), 88, avg).toFixed(1),
      max: +clamp(avg + 1.5 + rng01(r), avg, 100).toFixed(1),
    },
    _synthetic: true,
  };
}
function rng01(r) {
  return r();
}

function synthRestingHr(username, dateStr) {
  const v = vitalityFactor(username, dateStr);
  const r = rngFor(`${username}|${dateStr}|rhr`);
  return Math.round(clamp(gauss(r, RHR.mean - v * 2.5, RHR.sd), RHR.min, RHR.max));
}

function synthHeartEntry(username, dateStr) {
  const restingHeartRate = synthRestingHr(username, dateStr);
  return {
    dateTime: dateStr,
    value: {
      restingHeartRate,
      customHeartRateZones: [],
      heartRateZones: [
        { name: "Out of Range", min: 30, max: 110, minutes: 1200, caloriesOut: 1400 },
        { name: "Fat Burn", min: 110, max: 140, minutes: 180, caloriesOut: 320 },
        { name: "Cardio", min: 140, max: 170, minutes: 50, caloriesOut: 180 },
        { name: "Peak", min: 170, max: 220, minutes: 10, caloriesOut: 60 },
      ],
    },
    _synthetic: true,
  };
}

function synthSteps(username, dateStr) {
  const v = vitalityFactor(username, dateStr);
  const r = rngFor(`${username}|${dateStr}|steps`);
  const base = STEPS.weekday[dow(dateStr)];
  return Math.round(clamp(gauss(r, base + v * 1500, STEPS.sd), STEPS.min, STEPS.max));
}

function synthActivityValue(username, dateStr, resource) {
  const r = rngFor(`${username}|${dateStr}|${resource}`);
  const steps = synthSteps(username, dateStr);
  switch (resource) {
    case "steps":
      return steps;
    case "calories":
      return Math.round(clamp(CAL.base + steps * CAL.perStep + gauss(r, 0, CAL.sd), CAL.min, CAL.max));
    case "distance":
      return +clamp(steps * DIST_PER_STEP + gauss(r, 0, 0.3), 0.5, 12).toFixed(2);
    case "floors": {
      const v = vitalityFactor(username, dateStr);
      return Math.round(clamp(gauss(r, FLOORS.mean + v * 3, FLOORS.sd), FLOORS.min, FLOORS.max));
    }
    case "elevation": {
      const floors = synthActivityValue(username, dateStr, "floors");
      return Math.round(clamp(floors * ELEV_PER_FLOOR + gauss(r, 0, 6), 3, 100));
    }
    default:
      return steps;
  }
}

/** -------------------------------------------------------------------------
 * Gap-fill merge helpers — return the SAME raw Fitbit shape, real entries kept.
 * ---------------------------------------------------------------------- */
function isFill() {
  return SYNTHETIC_MODE === "fill";
}

function fillSleepRange(username, raw, startDate, endDate) {
  if (!isFill()) return raw;
  const list = Array.isArray(raw?.sleep) ? raw.sleep.slice() : [];
  const present = new Set(list.filter((s) => s && s.dateOfSleep).map((s) => s.dateOfSleep));
  for (const d of eachDate(startDate, endDate)) {
    if (!present.has(d)) list.push(synthSleep(username, d));
  }
  list.sort((a, b) => String(a.dateOfSleep).localeCompare(String(b.dateOfSleep)));
  return { ...(raw || {}), sleep: list };
}

function fillSleepSingle(username, raw, date) {
  if (!isFill()) return raw;
  const has = Array.isArray(raw?.sleep) && raw.sleep.some((s) => s && (s.minutesAsleep || s.duration));
  if (has) return raw;
  return { sleep: [synthSleep(username, date)] };
}

/** Generic "keyed daily series" filler for { [key]: [ {dateTime, value} ] } shapes. */
function fillKeyedSeries(username, raw, key, startDate, endDate, makeEntry, { treatZeroAsGap = false } = {}) {
  if (!isFill()) return raw;
  const list = Array.isArray(raw?.[key]) ? raw[key].slice() : [];
  const byDate = new Map();
  for (const e of list) {
    const d = e?.dateTime || e?.date;
    if (d) byDate.set(d, e);
  }
  const out = [];
  for (const d of eachDate(startDate, endDate)) {
    const existing = byDate.get(d);
    const numeric = existing ? Number(existing.value?.dailyRmssd ?? existing.value?.breathingRate ?? existing.value?.restingHeartRate ?? existing.value) : NaN;
    const isGap = !existing || !Number.isFinite(numeric) || (treatZeroAsGap && numeric <= 0);
    out.push(isGap ? makeEntry(username, d) : existing);
  }
  return { ...(raw || {}), [key]: out };
}

/** Activity series: value is a string number; Fitbit fills 0 for no-wear → treat 0 as gap. */
function fillActivitySeries(username, raw, resource, startDate, endDate) {
  if (!isFill()) return raw;
  const key = `activities-${resource}`;
  const list = Array.isArray(raw?.[key]) ? raw[key].slice() : [];
  const byDate = new Map();
  for (const e of list) {
    const d = e?.dateTime || e?.date;
    if (d) byDate.set(d, e);
  }
  const out = [];
  for (const d of eachDate(startDate, endDate)) {
    const existing = byDate.get(d);
    const num = existing ? parseFloat(existing.value) : NaN;
    const isGap = !existing || !Number.isFinite(num) || num <= 0;
    out.push(isGap ? { dateTime: d, value: String(synthActivityValue(username, d, resource)), _synthetic: true } : existing);
  }
  return { ...(raw || {}), [key]: out };
}

/** SpO2 range comes back as a bare array. */
function fillSpo2Range(username, raw, startDate, endDate) {
  if (!isFill()) return raw;
  const list = Array.isArray(raw) ? raw.slice() : [];
  const byDate = new Map();
  for (const e of list) if (e?.dateTime) byDate.set(e.dateTime, e);
  const out = [];
  for (const d of eachDate(startDate, endDate)) {
    const existing = byDate.get(d);
    const num = existing ? Number(existing.value?.avg ?? existing.value) : NaN;
    out.push(!existing || !Number.isFinite(num) ? synthSpo2(username, d) : existing);
  }
  return out;
}
function fillSpo2Single(username, raw, date) {
  if (!isFill()) return raw;
  const num = Number(raw?.value?.avg ?? raw?.value);
  if (Number.isFinite(num)) return raw;
  return synthSpo2(username, date);
}

/** Heart range/period: { "activities-heart": [ {dateTime, value:{restingHeartRate}} ] } */
function fillHeartSeries(username, raw, startDate, endDate) {
  return fillKeyedSeries(username, raw, "activities-heart", startDate, endDate, synthHeartEntry);
}

/** Activity summary single-day: ensure summary.steps populated. */
function fillActivitySummary(username, raw, date) {
  if (!isFill()) return raw;
  const summary = raw?.summary || {};
  if (Number(summary.steps) > 0) return raw;
  const steps = synthSteps(username, date);
  const calories = synthActivityValue(username, date, "calories");
  const distance = synthActivityValue(username, date, "distance");
  const floors = synthActivityValue(username, date, "floors");
  const elevation = synthActivityValue(username, date, "elevation");
  return {
    activities: raw?.activities?.length ? raw.activities : [],
    goals: raw?.goals || { steps: 10000, caloriesOut: 2300, distance: 8.05, floors: 10, activeMinutes: 30 },
    summary: {
      ...summary,
      steps,
      caloriesOut: calories,
      activityCalories: Math.round(calories * 0.4),
      distances: [{ activity: "total", distance }],
      floors,
      elevation,
      sedentaryMinutes: 700,
      lightlyActiveMinutes: 180,
      fairlyActiveMinutes: Math.round(steps / 600),
      veryActiveMinutes: Math.round(steps / 900),
    },
    _synthetic: true,
  };
}

/** -------------------------------------------------------------------------
 * Active Zone Minutes (AZM)
 * ---------------------------------------------------------------------- */
function synthAzm(username, dateStr) {
  const v = vitalityFactor(username, dateStr);
  const r = rngFor(`${username}|${dateStr}|azm`);
  // log-normal base (median ~9), boosted on high-vitality days for occasional spikes
  let azm = Math.exp(gauss(r, AZM.lnMean + v * 0.5, AZM.lnSd));
  if (v > 0.4 && r() < 0.5) azm *= 1.8 + r() * 2.2; // occasional workout spike
  azm = Math.round(clamp(azm, AZM.min, AZM.max));
  // fat-burn dominant; cardio appears on bigger days; peak only on large days
  let cardio = azm > 25 && r() < 0.6 ? Math.round(azm * (0.1 + r() * 0.2)) : 0;
  let peak = azm > 120 && r() < 0.4 ? Math.round(azm * 0.03) : 0;
  let fatBurn = Math.max(0, azm - cardio - peak);
  const value = { activeZoneMinutes: azm, fatBurnActiveZoneMinutes: fatBurn };
  if (cardio > 0) value.cardioActiveZoneMinutes = cardio;
  if (peak > 0) value.peakActiveZoneMinutes = peak;
  return { dateTime: dateStr, value, _synthetic: true };
}

/** Gap-fill AZM range — key "activities-active-zone-minutes". */
function fillAzmRange(username, raw, startDate, endDate) {
  if (!isFill()) return raw;
  const key = "activities-active-zone-minutes";
  const list = Array.isArray(raw?.[key]) ? raw[key].slice() : [];
  const byDate = new Map();
  for (const e of list) {
    const d = e?.dateTime || e?.date;
    if (d) byDate.set(d, e);
  }
  const out = [];
  for (const d of eachDate(startDate, endDate)) {
    const existing = byDate.get(d);
    const num = existing ? Number(existing.value?.activeZoneMinutes ?? existing.value) : NaN;
    out.push(!existing || !Number.isFinite(num) ? synthAzm(username, d) : existing);
  }
  return { ...(raw || {}), [key]: out };
}

/** -------------------------------------------------------------------------
 * Named exercise sessions (Walk / HIIT) — exact Fitbit `activities[]` shape.
 * ---------------------------------------------------------------------- */
function pickExerciseType(r) {
  const x = r();
  let acc = 0;
  for (const t of EXERCISE_TYPES) {
    acc += t.weight;
    if (x <= acc) return t;
  }
  return EXERCISE_TYPES[0];
}

/** Returns an array of synthetic session entries for a date (possibly empty on rest days). */
function synthExerciseSessions(username, dateStr) {
  const r = rngFor(`${username}|${dateStr}|exercise`);
  // Is this an active day? (weekday-dependent probability)
  if (r() > EXERCISE_ACTIVE_PROB[dow(dateStr)]) return [];
  const nSessions = Math.round(clamp(gauss(r, 3, 1.8), 1, 8));
  const sessions = [];
  for (let i = 0; i < nSessions; i++) {
    const t = pickExerciseType(r);
    const durationMin = Math.round(clamp(gauss(r, t.durMean, t.durSd), t.durMin, t.durMax));
    const calories = Math.round(durationMin * t.calPerMin * (0.85 + r() * 0.3));
    const steps = Math.round(durationMin * t.stepsPerMin * (0.85 + r() * 0.3));
    const distance = t.hasDistance ? +(durationMin * t.milesPerMin * (0.85 + r() * 0.3)).toFixed(5) : 0;
    // start times in afternoon/evening window (13:00–19:30)
    const startMinutes = Math.round(clamp(gauss(r, 16 * 60, 120), 13 * 60, 19 * 60 + 30));
    const hh = String(Math.floor(startMinutes / 60)).padStart(2, "0");
    const mm = String(startMinutes % 60).padStart(2, "0");
    sessions.push({
      logId: Number(`${hashStr(`${username}|${dateStr}|${i}`)}`),
      activityId: t.activityId,
      activityParentId: t.activityId,
      activityParentName: t.name,
      name: t.name,
      calories,
      distance,
      steps,
      duration: durationMin * 60000,
      startDate: dateStr,
      startTime: `${hh}:${mm}`,
      isFavorite: false,
      hasActiveZoneMinutes: true,
      hasStartTime: true,
      _synthetic: true,
    });
  }
  // sort sessions by start time
  sessions.sort((a, b) => a.startTime.localeCompare(b.startTime));
  return sessions;
}

/**
 * Gap-fill exercise log. Keeps ALL real sessions; only synthesizes for days AFTER the
 * last real session date (the migration void) — so genuine historical rest days are NOT
 * given fake workouts. `realActivities` = normalized entries with `startDate`.
 */
function fillExerciseLog(username, realActivities, startDate, endDate) {
  const real = Array.isArray(realActivities) ? realActivities.slice() : [];
  const byDate = new Set(real.map((a) => a.startDate));
  let maxRealDate = null;
  for (const a of real) if (!maxRealDate || a.startDate > maxRealDate) maxRealDate = a.startDate;
  const out = real.slice();
  if (isFill()) {
    for (const d of eachDate(startDate, endDate)) {
      if (byDate.has(d)) continue;
      if (maxRealDate && d <= maxRealDate) continue; // within real coverage → genuine rest day
      out.push(...synthExerciseSessions(username, d));
    }
  }
  out.sort((a, b) => `${a.startDate}T${a.startTime || ""}`.localeCompare(`${b.startDate}T${b.startTime || ""}`));
  return { activities: out };
}

module.exports = {
  SYNTHETIC_MODE,
  periodToRange,
  fillSleepRange,
  fillSleepSingle,
  fillKeyedSeries,
  fillActivitySeries,
  fillSpo2Range,
  fillSpo2Single,
  fillHeartSeries,
  fillActivitySummary,
  fillAzmRange,
  fillExerciseLog,
  synthHrv,
  synthBr,
  synthAzm,
  synthExerciseSessions,
  // exposed for tests
  _internal: { synthSleep, synthSteps, synthActivityValue, eachDate, vitalityFactor },
};
