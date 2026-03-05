/**
 * Small, deterministic analytics helpers.
 *
 * These functions are intentionally simple because they run inside the Alexa time budget.
 * Anything heavier can be added later as an async enrichment step.
 */

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toNumericSeries(points = []) {
  return (Array.isArray(points) ? points : [])
    .map((point, idx) => ({
      idx,
      date: point?.date || null,
      label: String(point?.label ?? point?.date ?? idx + 1),
      value: Number(point?.value),
    }))
    .filter((point) => Number.isFinite(point.value));
}

function average(values = []) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function calculateStats(points = [], goal = null) {
  const normalized = toNumericSeries(points);
  const values = normalized.map((point) => point.value);

  if (!values.length) {
    return {
      avg: 0,
      high: 0,
      low: 0,
      goal: Number.isFinite(Number(goal)) ? Number(goal) : null,
      wowChangePct: 0,
      current: 0,
      previousAvg: 0,
      currentAvg: 0,
    };
  }

  const avg = Math.round(average(values) * 10) / 10;
  const high = Math.max(...values);
  const low = Math.min(...values);
  const current = values[values.length - 1];

  const half = Math.floor(values.length / 2);
  const previous = values.slice(0, half);
  const currentWindow = values.slice(half);
  const previousAvg = previous.length ? average(previous) : 0;
  const currentAvg = currentWindow.length ? average(currentWindow) : average(values);
  const wowChangePct = previousAvg > 0 ? Math.round(((currentAvg - previousAvg) / previousAvg) * 100) : 0;

  return {
    avg,
    high,
    low,
    current,
    goal: Number.isFinite(Number(goal)) ? Number(goal) : null,
    previousAvg: Math.round(previousAvg * 10) / 10,
    currentAvg: Math.round(currentAvg * 10) / 10,
    wowChangePct,
  };
}

function detectAnomalies(points = []) {
  const normalized = toNumericSeries(points);
  if (normalized.length < 5) return [];

  const values = normalized.map((point) => point.value);
  const avg = average(values);
  const variance = average(values.map((value) => (value - avg) ** 2));
  const stdDev = Math.sqrt(variance);
  if (stdDev <= 0) return [];

  return normalized
    .map((point) => {
      const z = (point.value - avg) / stdDev;
      if (Math.abs(z) < 1.5) return null;
      return {
        date: point.date,
        label: point.label,
        value: point.value,
        severity: clamp(Math.round(Math.abs(z) * 10), 1, 10),
        reason: z > 0 ? "spike" : "drop",
      };
    })
    .filter(Boolean);
}

function splitIntoPeriods(points = [], windowDays = 7) {
  const normalized = toNumericSeries(points);
  if (!normalized.length) return { previous: [], current: [] };
  const current = normalized.slice(-windowDays);
  const previous = normalized.slice(-(windowDays * 2), -windowDays);
  return { previous, current };
}

function comparePeriods(points = [], windowDays = 7) {
  const { previous, current } = splitIntoPeriods(points, windowDays);
  const previousAvg = average(previous.map((point) => point.value));
  const currentAvg = average(current.map((point) => point.value));
  const changePct = previousAvg > 0 ? Math.round(((currentAvg - previousAvg) / previousAvg) * 100) : 0;

  return {
    previous,
    current,
    previousAvg: Math.round(previousAvg * 10) / 10,
    currentAvg: Math.round(currentAvg * 10) / 10,
    changePct,
    direction: changePct > 4 ? "up" : changePct < -4 ? "down" : "steady",
  };
}

function pickHighlight(points = []) {
  const normalized = toNumericSeries(points);
  if (!normalized.length) return null;

  let highest = normalized[0];
  let lowest = normalized[0];
  normalized.forEach((point) => {
    if (point.value > highest.value) highest = point;
    if (point.value < lowest.value) lowest = point;
  });

  const anomalies = detectAnomalies(normalized);
  if (anomalies.length) {
    const strongest = [...anomalies].sort((a, b) => b.severity - a.severity)[0];
    return { ...strongest, mode: "anomaly" };
  }

  return {
    label: lowest.label,
    date: lowest.date,
    value: lowest.value,
    reason: "notable_low",
    mode: "range",
    highest,
  };
}

/**
 * A lightweight relationship summary.
 *
 * Example use:
 * - primary = sleep hours
 * - secondary = next-day steps
 *
 * We split the primary metric into "higher" vs "lower" days around the median and compare
 * the average secondary value for those groups.
 */
function describeRelationship(primaryPoints = [], secondaryPoints = [], { shiftSecondaryByDays = 0 } = {}) {
  const primary = toNumericSeries(primaryPoints);
  const secondary = toNumericSeries(secondaryPoints);
  if (primary.length < 4 || secondary.length < 4) {
    return {
      confidence: "Low",
      statement: "There is not enough data for a reliable comparison yet.",
      grouped: [],
      effectDirection: "unknown",
    };
  }

  const secondaryByDate = new Map();
  secondary.forEach((point) => secondaryByDate.set(String(point.date), point.value));

  const aligned = primary
    .map((point) => {
      const keyDate = point.date ? new Date(`${point.date}T00:00:00`) : null;
      if (!keyDate) return null;
      keyDate.setDate(keyDate.getDate() + shiftSecondaryByDays);
      const shiftedKey = `${keyDate.getFullYear()}-${String(keyDate.getMonth() + 1).padStart(2, "0")}-${String(keyDate.getDate()).padStart(2, "0")}`;
      const secondaryValue = secondaryByDate.get(shiftedKey);
      if (!Number.isFinite(secondaryValue)) return null;
      return {
        date: point.date,
        primary: point.value,
        secondary: secondaryValue,
      };
    })
    .filter(Boolean);

  if (aligned.length < 4) {
    return {
      confidence: "Low",
      statement: "I can only make a limited comparison from the available days.",
      grouped: [],
      effectDirection: "unknown",
    };
  }

  const sortedPrimary = aligned.map((item) => item.primary).sort((a, b) => a - b);
  const median = sortedPrimary[Math.floor(sortedPrimary.length / 2)] || 0;

  const higher = aligned.filter((item) => item.primary >= median);
  const lower = aligned.filter((item) => item.primary < median);

  const higherAvg = average(higher.map((item) => item.secondary));
  const lowerAvg = average(lower.map((item) => item.secondary));
  const deltaPct = lowerAvg > 0 ? Math.round(((higherAvg - lowerAvg) / lowerAvg) * 100) : 0;

  const effectDirection = deltaPct > 5 ? "higher" : deltaPct < -5 ? "lower" : "similar";
  const confidence = aligned.length >= 10 ? "Medium" : "Low";

  let statement = "The two patterns look fairly similar.";
  if (effectDirection === "higher") {
    statement = `On higher ${"sleep"} days, the other metric tended to be about ${Math.abs(deltaPct)}% higher.`;
  } else if (effectDirection === "lower") {
    statement = `On higher ${"sleep"} days, the other metric tended to be about ${Math.abs(deltaPct)}% lower.`;
  }

  return {
    confidence,
    statement,
    effectDirection,
    grouped: [
      { label: "Higher sleep days", value: Math.round(higherAvg * 10) / 10, count: higher.length },
      { label: "Lower sleep days", value: Math.round(lowerAvg * 10) / 10, count: lower.length },
    ],
  };
}

module.exports = {
  calculateStats,
  detectAnomalies,
  comparePeriods,
  pickHighlight,
  describeRelationship,
  toNumericSeries,
};