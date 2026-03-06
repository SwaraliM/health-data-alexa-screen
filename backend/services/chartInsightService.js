/**
 * backend/services/chartInsightService.js
 *
 * Deterministic analytics only.
 * GPT should not do the math. This file does the math.
 */

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toNumericSeries(points = []) {
  return (Array.isArray(points) ? points : [])
    .map((point, idx) => ({
      idx,
      label: String(point?.label ?? point?.date ?? idx + 1),
      fullLabel: String(point?.fullLabel ?? point?.label ?? point?.date ?? idx + 1),
      date: point?.date || null,
      value: Number(point?.value),
    }))
    .filter((point) => Number.isFinite(point.value));
}

function avg(values = []) {
  if (!values.length) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function calculateStats(points = [], goal = null) {
  const normalized = toNumericSeries(points);
  const values = normalized.map((point) => point.value);

  if (!values.length) {
    return {
      count: 0,
      avg: 0,
      high: 0,
      low: 0,
      min: 0,
      max: 0,
      current: 0,
      goal: Number.isFinite(Number(goal)) ? Number(goal) : null,
      wowChangePct: 0,
    };
  }

  const high = Math.max(...values);
  const low = Math.min(...values);
  const current = values[values.length - 1];
  const mean = avg(values);

  const half = Math.floor(values.length / 2);
  const prevValues = values.slice(0, half);
  const curValues = values.slice(half);
  const prevAvg = avg(prevValues);
  const curAvg = avg(curValues);
  const wowChangePct = prevAvg > 0 ? Math.round(((curAvg - prevAvg) / prevAvg) * 100) : 0;

  return {
    count: values.length,
    avg: Math.round(mean * 10) / 10,
    high,
    low,
    min: low,
    max: high,
    current,
    goal: Number.isFinite(Number(goal)) ? Number(goal) : null,
    wowChangePct,
  };
}

function comparePeriods(points = [], baseDays = 7) {
  const normalized = toNumericSeries(points);
  if (!normalized.length) {
    return {
      previousAvg: 0,
      currentAvg: 0,
      changePct: 0,
      direction: "flat",
      previous: [],
      current: [],
    };
  }

  const current = normalized.slice(-baseDays);
  const previous = normalized.slice(-(baseDays * 2), -baseDays);

  const currentAvg = avg(current.map((p) => p.value));
  const previousAvg = avg(previous.map((p) => p.value));
  const changePct = previousAvg > 0 ? Math.round(((currentAvg - previousAvg) / previousAvg) * 100) : 0;

  let direction = "flat";
  if (changePct > 4) direction = "up";
  else if (changePct < -4) direction = "down";

  return {
    previousAvg: Math.round(previousAvg * 10) / 10,
    currentAvg: Math.round(currentAvg * 10) / 10,
    changePct,
    direction,
    previous,
    current,
  };
}

function pickHighlight(points = []) {
  const normalized = toNumericSeries(points);
  if (!normalized.length) return null;

  const maxPoint = normalized.reduce((best, point) => (point.value > best.value ? point : best), normalized[0]);
  const minPoint = normalized.reduce((best, point) => (point.value < best.value ? point : best), normalized[0]);

  if (Math.abs(maxPoint.value - minPoint.value) < 1) {
    return {
      ...maxPoint,
      reason: "steady",
    };
  }

  const range = Math.abs(maxPoint.value - minPoint.value);
  if (range / Math.max(1, Math.abs(minPoint.value)) > 0.15) {
    return { ...minPoint, reason: "lowest" };
  }
  return { ...maxPoint, reason: "highest" };
}

function detectAnomalies(points = []) {
  const normalized = toNumericSeries(points);
  if (normalized.length < 5) return [];

  const values = normalized.map((point) => point.value);
  const mean = avg(values);
  const variance = avg(values.map((value) => (value - mean) ** 2));
  const stdDev = Math.sqrt(variance);
  if (!Number.isFinite(stdDev) || stdDev === 0) return [];

  return normalized
    .map((point) => {
      const z = (point.value - mean) / stdDev;
      if (Math.abs(z) < 1.6) return null;
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

function pearson(xs = [], ys = []) {
  if (!xs.length || xs.length !== ys.length) return 0;
  const xAvg = avg(xs);
  const yAvg = avg(ys);
  let num = 0;
  let xDen = 0;
  let yDen = 0;

  for (let i = 0; i < xs.length; i += 1) {
    const dx = xs[i] - xAvg;
    const dy = ys[i] - yAvg;
    num += dx * dy;
    xDen += dx * dx;
    yDen += dy * dy;
  }

  const den = Math.sqrt(xDen * yDen);
  if (!den) return 0;
  return num / den;
}

function shiftDateString(dateString, deltaDays) {
  if (!dateString) return dateString;
  const date = new Date(`${dateString}T00:00:00`);
  if (Number.isNaN(date.getTime())) return dateString;
  date.setDate(date.getDate() + deltaDays);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function describeRelationship(primaryPoints = [], secondaryPoints = [], opts = {}) {
  const shiftSecondaryByDays = Number(opts?.shiftSecondaryByDays || 0);
  const primaryMetricLabel = String(opts?.primaryMetricLabel || "primary metric");

  const byPrimaryDate = new Map(
    toNumericSeries(primaryPoints).map((p) => [p.date || p.label, p])
  );

  const secondaryNormalized = toNumericSeries(secondaryPoints);

  const pairs = secondaryNormalized
    .map((secondaryPoint) => {
      const lookupDate = secondaryPoint.date
        ? shiftDateString(secondaryPoint.date, -shiftSecondaryByDays)
        : secondaryPoint.label;
      const primaryPoint = byPrimaryDate.get(lookupDate);
      if (!primaryPoint) return null;
      return {
        primary: primaryPoint.value,
        secondary: secondaryPoint.value,
        date: secondaryPoint.date || primaryPoint.date || null,
      };
    })
    .filter(Boolean);

  if (pairs.length < 4) {
    return {
      statement: "I do not have enough overlapping days to show a reliable relationship yet.",
      effectDirection: "flat",
      correlation: 0,
      grouped: [],
    };
  }

  const primaryValues = pairs.map((p) => p.primary).sort((a, b) => a - b);
  const median = primaryValues[Math.floor(primaryValues.length / 2)];

  const highBucket = pairs.filter((p) => p.primary >= median);
  const lowBucket = pairs.filter((p) => p.primary < median);

  const highAvg = avg(highBucket.map((p) => p.secondary));
  const lowAvg = avg(lowBucket.map((p) => p.secondary));
  const corr = pearson(
    pairs.map((p) => p.primary),
    pairs.map((p) => p.secondary)
  );

  let effectDirection = "flat";
  if (highAvg > lowAvg * 1.03) effectDirection = "higher";
  else if (lowAvg > highAvg * 1.03) effectDirection = "lower";

  let statement = `When ${primaryMetricLabel} was higher, the other metric stayed fairly similar.`;
  if (effectDirection === "higher") {
    statement = `On higher ${primaryMetricLabel} days, the other metric tended to be higher as well.`;
  } else if (effectDirection === "lower") {
    statement = `On higher ${primaryMetricLabel} days, the other metric tended to be lower.`;
  }

  return {
    statement,
    effectDirection,
    correlation: Math.round(corr * 100) / 100,
    grouped: [
      { label: `Lower ${primaryMetricLabel}`, value: Math.round(lowAvg * 10) / 10, count: lowBucket.length },
      { label: `Higher ${primaryMetricLabel}`, value: Math.round(highAvg * 10) / 10, count: highBucket.length },
    ],
  };
}

function alignSeriesMap(metricSeriesMap = {}) {
  const normalizedMaps = {};
  const allKeys = new Set();

  Object.entries(metricSeriesMap).forEach(([metricKey, points]) => {
    const normalized = toNumericSeries(points);
    const map = new Map();
    normalized.forEach((point, idx) => {
      const key = String(point.date || point.fullLabel || point.label || idx);
      map.set(key, point);
      allKeys.add(key);
    });
    normalizedMaps[metricKey] = map;
  });

  const orderedKeys = [...allKeys];
  const labels = orderedKeys.map((key) => {
    for (const metricKey of Object.keys(normalizedMaps)) {
      const point = normalizedMaps[metricKey].get(key);
      if (point) return point.label || point.fullLabel || key;
    }
    return key;
  });

  const valuesByMetric = {};
  Object.entries(normalizedMaps).forEach(([metricKey, map]) => {
    valuesByMetric[metricKey] = orderedKeys.map((key) => {
      const point = map.get(key);
      return point ? point.value : null;
    });
  });

  return {
    orderedKeys,
    labels,
    valuesByMetric,
  };
}

module.exports = {
  calculateStats,
  comparePeriods,
  pickHighlight,
  detectAnomalies,
  describeRelationship,
  alignSeriesMap,
};