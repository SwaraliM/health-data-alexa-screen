/**
 * backend/services/chartInsightService.js
 *
 * Deterministic analytics only.
 * GPT must not do arithmetic or statistical calculations.
 *
 * This service turns normalized chart-ready series into stable, explainable facts:
 * - summary statistics
 * - recent-vs-previous comparisons
 * - anomaly detection
 * - weekday vs weekend differences
 * - strongest day-to-day shifts
 * - cross-metric relationship summaries for scatter/comparison views
 */

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round1(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10) / 10;
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
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sum(values = []) {
  return values.reduce((total, value) => total + (Number(value) || 0), 0);
}

function percentile(sortedValues = [], ratio = 0.5) {
  if (!sortedValues.length) return 0;
  const idx = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.round((sortedValues.length - 1) * ratio))
  );
  return sortedValues[idx];
}

function calcStdDev(values = []) {
  if (!values.length) return 0;
  const mean = avg(values);
  const variance = avg(values.map((value) => (value - mean) ** 2));
  return Math.sqrt(Math.max(0, variance));
}

function linearSlope(values = []) {
  if (values.length < 2) return 0;
  const xs = values.map((_, idx) => idx + 1);
  const xAvg = avg(xs);
  const yAvg = avg(values);
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < values.length; i += 1) {
    numerator += (xs[i] - xAvg) * (values[i] - yAvg);
    denominator += (xs[i] - xAvg) ** 2;
  }
  return denominator ? numerator / denominator : 0;
}

function percentChange(current, previous) {
  const cur = Number(current);
  const prev = Number(previous);
  if (!Number.isFinite(cur) || !Number.isFinite(prev) || prev === 0) return 0;
  return round1(((cur - prev) / prev) * 100);
}

function normalizeDirectionFromPct(changePct, threshold = 3) {
  const value = Number(changePct) || 0;
  if (value > Math.abs(threshold)) return "up";
  if (value < -Math.abs(threshold)) return "down";
  return "flat";
}

function labelCorrelationStrength(correlation = 0) {
  const abs = Math.abs(Number(correlation) || 0);
  if (abs >= 0.75) return "strong";
  if (abs >= 0.45) return "moderate";
  if (abs >= 0.2) return "weak";
  return "very_weak";
}

function labelTrendStrength(values = []) {
  if (!values.length) return "none";
  const stdDev = calcStdDev(values);
  const slope = linearSlope(values);
  const normalizedSlope = stdDev > 0 ? Math.abs(slope) / stdDev : Math.abs(slope);
  if (normalizedSlope >= 0.45) return "strong";
  if (normalizedSlope >= 0.2) return "moderate";
  if (normalizedSlope >= 0.08) return "weak";
  return "flat";
}

function calculateStats(points = [], goal = null) {
  const normalized = toNumericSeries(points);
  const values = normalized.map((point) => point.value);
  const sorted = [...values].sort((a, b) => a - b);
  const mean = avg(values);
  const stdDev = calcStdDev(values);
  const slope = linearSlope(values);
  const current = values.length ? values[values.length - 1] : 0;

  return {
    count: values.length,
    avg: round1(mean),
    min: values.length ? Math.min(...values) : 0,
    max: values.length ? Math.max(...values) : 0,
    high: values.length ? Math.max(...values) : 0,
    low: values.length ? Math.min(...values) : 0,
    current,
    sum: round1(sum(values)),
    median: round1(percentile(sorted, 0.5)),
    p25: round1(percentile(sorted, 0.25)),
    p75: round1(percentile(sorted, 0.75)),
    slope: round1(slope),
    slopeDirection: normalizeDirectionFromPct(slope, 0.15),
    trendStrength: labelTrendStrength(values),
    range: values.length ? round1(Math.max(...values) - Math.min(...values)) : 0,
    variability: round1(stdDev),
    coefficientOfVariation: mean ? round1((stdDev / Math.max(1, mean)) * 100) : 0,
    consistencyScore: values.length
      ? clamp(Math.round((1 - stdDev / Math.max(1, mean || 1)) * 100), 0, 100)
      : 0,
    goal: Number.isFinite(Number(goal)) ? Number(goal) : null,
    goalProgressPct: Number.isFinite(Number(goal)) && Number(goal) > 0
      ? clamp(Math.round((current / Number(goal)) * 100), 0, 200)
      : null,
    last3Avg: round1(avg(values.slice(-3))),
    last7Avg: round1(avg(values.slice(-7))),
  };
}

function comparePeriods(points = [], baseDays = 7) {
  const normalized = toNumericSeries(points);
  const current = normalized.slice(-baseDays);
  const previous = normalized.slice(-(baseDays * 2), -baseDays);
  const currentValues = current.map((point) => point.value);
  const previousValues = previous.map((point) => point.value);
  const currentAvg = avg(currentValues);
  const previousAvg = avg(previousValues);
  const changePct = percentChange(currentAvg, previousAvg);
  const baselineDelta = round1(currentAvg - previousAvg);
  const currentMedian = round1(percentile([...currentValues].sort((a, b) => a - b), 0.5));
  const previousMedian = round1(percentile([...previousValues].sort((a, b) => a - b), 0.5));

  return {
    previous,
    current,
    sampleSizeCurrent: current.length,
    sampleSizePrevious: previous.length,
    previousAvg: round1(previousAvg),
    currentAvg: round1(currentAvg),
    previousMedian,
    currentMedian,
    changePct,
    absoluteDelta: baselineDelta,
    direction: normalizeDirectionFromPct(changePct, 3),
    baselineDelta,
    significanceHint: Math.abs(changePct) >= 10 ? "clear" : Math.abs(changePct) >= 4 ? "small" : "minimal",
    enoughHistory: previous.length >= Math.max(3, Math.min(baseDays, 5)),
  };
}

/**
 * Build a synthetic previous/current split from a single series so grouped_bar can render
 * when full comparePeriods history is not available (e.g. first 2 weeks of data).
 * Returns same shape as comparePeriods: { previous, current } with items { label, value, date, ... }.
 */
function buildSyntheticPeriodComparison(points = [], baseDays = 7) {
  const normalized = toNumericSeries(points);
  if (normalized.length < 2) return null;
  const half = Math.max(1, Math.floor(normalized.length / 2));
  const previous = normalized.slice(0, half);
  const current = normalized.slice(half);
  return {
    previous: previous.map((p) => ({ ...p, value: Number(p.value) })),
    current: current.map((p) => ({ ...p, value: Number(p.value) })),
    changePct: percentChange(avg(current.map((p) => p.value)), avg(previous.map((p) => p.value))),
    enoughHistory: true,
  };
}

function pickHighlight(points = []) {
  const normalized = toNumericSeries(points);
  if (!normalized.length) return null;
  const maxPoint = normalized.reduce((best, point) => (point.value > best.value ? point : best), normalized[0]);
  const minPoint = normalized.reduce((best, point) => (point.value < best.value ? point : best), normalized[0]);
  if (Math.abs(maxPoint.value - minPoint.value) < 1) {
    return { ...maxPoint, reason: "steady", spread: round1(maxPoint.value - minPoint.value) };
  }
  return Math.abs(maxPoint.value) >= Math.abs(minPoint.value)
    ? { ...maxPoint, reason: "highest", spread: round1(maxPoint.value - minPoint.value) }
    : { ...minPoint, reason: "lowest", spread: round1(maxPoint.value - minPoint.value) };
}

function detectAnomalies(points = []) {
  const normalized = toNumericSeries(points);
  if (normalized.length < 5) return [];
  const values = normalized.map((point) => point.value);
  const mean = avg(values);
  const stdDev = calcStdDev(values);
  if (!stdDev) return [];
  return normalized
    .map((point) => {
      const z = (point.value - mean) / stdDev;
      if (Math.abs(z) < 1.6) return null;
      return {
        date: point.date,
        label: point.label,
        fullLabel: point.fullLabel,
        value: point.value,
        zScore: round1(z),
        severity: clamp(Math.round(Math.abs(z) * 10), 1, 10),
        reason: z > 0 ? "spike" : "drop",
        deviationFromAverage: round1(point.value - mean),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.severity - a.severity);
}

function groupWeekdayWeekend(points = []) {
  const normalized = toNumericSeries(points);
  const weekdays = [];
  const weekends = [];
  normalized.forEach((point) => {
    if (!point.date) return;
    const day = new Date(`${point.date}T00:00:00`).getDay();
    if (day === 0 || day === 6) weekends.push(point.value);
    else weekdays.push(point.value);
  });
  const weekdayAvg = round1(avg(weekdays));
  const weekendAvg = round1(avg(weekends));
  return {
    weekdayAvg,
    weekendAvg,
    difference: round1(weekendAvg - weekdayAvg),
    direction: weekendAvg > weekdayAvg * 1.03 ? "higher_weekend" : weekdayAvg > weekendAvg * 1.03 ? "higher_weekday" : "flat",
    weekdayCount: weekdays.length,
    weekendCount: weekends.length,
  };
}

function strongestChangeDay(points = []) {
  const normalized = toNumericSeries(points);
  if (normalized.length < 2) return null;
  let best = null;
  for (let i = 1; i < normalized.length; i += 1) {
    const delta = normalized[i].value - normalized[i - 1].value;
    if (!best || Math.abs(delta) > Math.abs(best.delta)) {
      best = {
        label: normalized[i].label,
        date: normalized[i].date,
        value: normalized[i].value,
        previousValue: normalized[i - 1].value,
        delta: round1(delta),
        direction: delta > 0 ? "up" : delta < 0 ? "down" : "flat",
        percentDelta: percentChange(normalized[i].value, normalized[i - 1].value),
      };
    }
  }
  return best;
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
  return den ? num / den : 0;
}

function buildRelationshipStatement({ effectDirection, strength, primaryMetricLabel, secondaryMetricLabel }) {
  const primaryLabel = String(primaryMetricLabel || "primary metric");
  const secondaryLabel = String(secondaryMetricLabel || "the other metric");
  if (effectDirection === "higher") {
    if (strength === "strong" || strength === "moderate") {
      return `On higher ${primaryLabel} days, ${secondaryLabel} also tended to be higher.`;
    }
    return `There was a slight tendency for ${secondaryLabel} to be higher on higher ${primaryLabel} days.`;
  }
  if (effectDirection === "lower") {
    if (strength === "strong" || strength === "moderate") {
      return `On higher ${primaryLabel} days, ${secondaryLabel} tended to be lower.`;
    }
    return `There was a slight tendency for ${secondaryLabel} to be lower on higher ${primaryLabel} days.`;
  }
  return `${primaryLabel} and ${secondaryLabel} stayed fairly similar across overlapping days.`;
}

function describeRelationship(primaryPoints = [], secondaryPoints = [], opts = {}) {
  const primarySeries = toNumericSeries(primaryPoints);
  const secondarySeries = toNumericSeries(secondaryPoints);
  const byDate = new Map(primarySeries.map((point) => [point.date || point.label, point]));
  const pairs = secondarySeries
    .map((point) => {
      const ref = byDate.get(point.date || point.label);
      if (!ref) return null;
      return {
        primary: ref.value,
        secondary: point.value,
        label: point.label,
        date: point.date,
      };
    })
    .filter(Boolean);

  const primaryMetricLabel = String(opts?.primaryMetricLabel || "primary metric");
  const secondaryMetricLabel = String(opts?.secondaryMetricLabel || "the other metric");

  if (pairs.length < 4) {
    return {
      statement: "I do not have enough overlapping days to show a reliable relationship yet.",
      effectDirection: "flat",
      correlation: 0,
      correlationStrength: "very_weak",
      overlapDays: pairs.length,
      confidence: "low",
      pairs,
      grouped: [],
      groupedEffectSummary: null,
    };
  }

  const primaryValues = pairs.map((pair) => pair.primary).sort((a, b) => a - b);
  const median = percentile(primaryValues, 0.5);
  const lowBucket = pairs.filter((pair) => pair.primary < median);
  const highBucket = pairs.filter((pair) => pair.primary >= median);
  const lowAvg = avg(lowBucket.map((pair) => pair.secondary));
  const highAvg = avg(highBucket.map((pair) => pair.secondary));
  const difference = round1(highAvg - lowAvg);
  const effectPct = percentChange(highAvg, lowAvg || 0);
  const rawCorrelation = pearson(
    pairs.map((pair) => pair.primary),
    pairs.map((pair) => pair.secondary)
  );
  const correlation = round1(rawCorrelation);
  const correlationStrength = labelCorrelationStrength(rawCorrelation);

  let effectDirection = "flat";
  if (highAvg > lowAvg * 1.03) effectDirection = "higher";
  if (lowAvg > highAvg * 1.03) effectDirection = "lower";

  const confidence = pairs.length >= 10 && correlationStrength !== "very_weak"
    ? "medium"
    : pairs.length >= 14 && (correlationStrength === "strong" || correlationStrength === "moderate")
      ? "high"
      : pairs.length >= 6
        ? "medium"
        : "low";

  const statement = buildRelationshipStatement({
    effectDirection,
    strength: correlationStrength,
    primaryMetricLabel,
    secondaryMetricLabel,
  });

  return {
    statement,
    effectDirection,
    correlation,
    correlationStrength,
    overlapDays: pairs.length,
    confidence,
    pairs,
    grouped: [
      { label: `Lower ${primaryMetricLabel}`, value: round1(lowAvg), count: lowBucket.length },
      { label: `Higher ${primaryMetricLabel}`, value: round1(highAvg), count: highBucket.length },
    ],
    groupedEffectSummary: {
      lowBucketAverage: round1(lowAvg),
      highBucketAverage: round1(highAvg),
      difference,
      effectPct,
      betterBucket: effectDirection === "higher" ? "higher_primary_days" : effectDirection === "lower" ? "lower_primary_days" : "similar",
    },
  };
}

function alignSeriesMap(metricSeriesMap = {}) {
  const allKeys = [];
  const valuesByMetric = {};
  const rowsByKey = new Map();
  const labels = [];
  const seen = new Set();

  Object.entries(metricSeriesMap).forEach(([metricKey, points]) => {
    const normalized = toNumericSeries(points);
    const metricMap = new Map();
    normalized.forEach((point) => {
      const key = String(point.date || point.fullLabel || point.label);
      metricMap.set(key, point);
      const existing = rowsByKey.get(key) || { key, label: point.label, fullLabel: point.fullLabel, date: point.date };
      existing[metricKey] = point.value;
      rowsByKey.set(key, existing);
      if (!seen.has(key)) {
        seen.add(key);
        allKeys.push(key);
      }
    });
    valuesByMetric[metricKey] = metricMap;
  });

  allKeys.sort();
  allKeys.forEach((key) => {
    const point = Object.values(valuesByMetric).map((metricMap) => metricMap.get(key)).find(Boolean);
    labels.push(point?.label || key);
  });

  const flattened = {};
  Object.entries(valuesByMetric).forEach(([metricKey, metricMap]) => {
    flattened[metricKey] = allKeys.map((key) => {
      const point = metricMap.get(key);
      return point ? point.value : null;
    });
  });

  const rows = allKeys.map((key) => ({ ...(rowsByKey.get(key) || { key }) }));

  return { orderedKeys: allKeys, labels, rows, valuesByMetric: flattened };
}

function rankMetricRelationships(metricSeriesMap = {}) {
  const keys = Object.keys(metricSeriesMap || {});
  const ranked = [];
  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i + 1; j < keys.length; j += 1) {
      const primaryMetric = keys[i];
      const secondaryMetric = keys[j];
      const relationship = describeRelationship(metricSeriesMap[primaryMetric], metricSeriesMap[secondaryMetric], {
        primaryMetricLabel: primaryMetric,
        secondaryMetricLabel: secondaryMetric,
      });
      ranked.push({
        primaryMetric,
        secondaryMetric,
        ...relationship,
        score: Math.abs(Number(relationship.correlation) || 0),
      });
    }
  }
  return ranked.sort((a, b) => b.score - a.score);
}

function summarizeIntradayFacts(points = [], intradaySummary = null) {
  const normalized = toNumericSeries(points);
  const windows = Array.isArray(intradaySummary?.windows) ? intradaySummary.windows : [];
  const strongestWindow = intradaySummary?.strongestWindow || null;
  const quietestWindow = intradaySummary?.quietestWindow || null;
  let largestIncrease = null;
  let largestDrop = null;

  for (let i = 1; i < normalized.length; i += 1) {
    const delta = normalized[i].value - normalized[i - 1].value;
    const candidate = {
      label: normalized[i].label,
      fullLabel: normalized[i].fullLabel,
      value: normalized[i].value,
      previousValue: normalized[i - 1].value,
      delta: round1(delta),
    };
    if (!largestIncrease || delta > largestIncrease.delta) largestIncrease = candidate;
    if (!largestDrop || delta < largestDrop.delta) largestDrop = candidate;
  }

  const rankedWindows = [...windows].sort((a, b) => Number(b.value || 0) - Number(a.value || 0));
  const takeaway = strongestWindow
    ? `${strongestWindow.label} was the busiest part of the day.`
    : normalized.length
      ? `${normalized[normalized.length - 1].label} was the latest recorded point.`
      : "This shows how the day changed over time.";

  return {
    takeaway,
    strongestWindow,
    quietestWindow,
    largestIncrease: largestIncrease && largestIncrease.delta > 0 ? largestIncrease : null,
    largestDrop: largestDrop && largestDrop.delta < 0 ? largestDrop : null,
    rankedWindows: rankedWindows.slice(0, 3).map((window) => ({
      label: window.label,
      value: round1(window.value),
      average: round1(window.avgValue || window.average || 0),
    })),
  };
}

function summarizeSleepQuality({
  sleepSeries = [],
  efficiencySeries = [],
  wakeSeries = [],
  bedtimeSeries = [],
  sleepTimingSummary = null,
  sleepStageBreakdown = null,
  sleepStageComparison = null,
} = {}) {
  const durationStats = calculateStats(sleepSeries);
  const efficiencyStats = calculateStats(efficiencySeries);
  const wakeStats = calculateStats(wakeSeries);
  const bedtimeStats = calculateStats(bedtimeSeries);
  const totalStageMinutes = Array.isArray(sleepStageBreakdown)
    ? sleepStageBreakdown.reduce((sum, item) => sum + (Number(item?.value) || 0), 0)
    : 0;
  const remMinutes = Array.isArray(sleepStageBreakdown)
    ? Number(sleepStageBreakdown.find((item) => String(item?.name).toLowerCase() === "rem")?.value || 0)
    : 0;
  const wakeStageMinutes = Array.isArray(sleepStageBreakdown)
    ? Number(sleepStageBreakdown.find((item) => String(item?.name).toLowerCase() === "awake")?.value || 0)
    : 0;
  const remShare = totalStageMinutes ? round1((remMinutes / totalStageMinutes) * 100) : 0;
  const wakeShare = totalStageMinutes ? round1((wakeStageMinutes / totalStageMinutes) * 100) : 0;
  const bedtimeVariability = round1(bedtimeStats.variability || 0);
  const factors = [];
  let score = 50;

  if ((durationStats.current || durationStats.avg) >= 7) {
    score += 12;
    factors.push("sleep duration was solid");
  } else if ((durationStats.current || durationStats.avg) < 6) {
    score -= 10;
    factors.push("sleep duration was on the short side");
  }

  if ((efficiencyStats.current || efficiencyStats.avg) >= 85) {
    score += 12;
    factors.push("sleep efficiency was strong");
  } else if ((efficiencyStats.current || efficiencyStats.avg) > 0 && (efficiencyStats.current || efficiencyStats.avg) < 78) {
    score -= 10;
    factors.push("sleep efficiency was lower than ideal");
  }

  if ((wakeStats.current || wakeStats.avg) > 45 || wakeShare >= 12) {
    score -= 10;
    factors.push("awake time was elevated");
  } else if ((wakeStats.current || wakeStats.avg) > 0) {
    score += 4;
    factors.push("awake time stayed fairly contained");
  }

  if (remShare >= 18) {
    score += 6;
    factors.push("REM sleep was reasonably represented");
  } else if (remShare > 0 && remShare < 14) {
    score -= 5;
    factors.push("REM sleep looked lighter than usual");
  }

  if (bedtimeVariability > 0 && bedtimeVariability <= 45) {
    score += 6;
    factors.push("bedtime stayed fairly regular");
  } else if (bedtimeVariability > 75) {
    score -= 6;
    factors.push("bedtime timing was variable");
  }

  if (Number(sleepTimingSummary?.minutesToFallAsleep || 0) >= 30) {
    score -= 5;
    factors.push("it took longer to fall asleep");
  }

  const boundedScore = clamp(Math.round(score), 0, 100);
  let headline = "Sleep quality looked mixed overall.";
  if (boundedScore >= 72) headline = "Sleep quality looked fairly strong overall.";
  else if (boundedScore <= 42) headline = "Sleep quality looked weaker overall.";

  const standoutStage = Array.isArray(sleepStageComparison)
    ? [...sleepStageComparison]
        .sort((a, b) => Math.abs(Number(b.differenceMinutes || 0)) - Math.abs(Number(a.differenceMinutes || 0)))[0]
    : null;

  return {
    score: boundedScore,
    headline,
    remShare,
    wakeShare,
    bedtimeVariability,
    standoutStage,
    factors: factors.slice(0, 4),
    takeaway: factors.length
      ? `${headline} ${factors[0].charAt(0).toUpperCase()}${factors[0].slice(1)}.`
      : headline,
  };
}

module.exports = {
  calculateStats,
  comparePeriods,
  buildSyntheticPeriodComparison,
  pickHighlight,
  detectAnomalies,
  describeRelationship,
  alignSeriesMap,
  percentChange,
  groupWeekdayWeekend,
  strongestChangeDay,
  rankMetricRelationships,
  summarizeIntradayFacts,
  summarizeSleepQuality,
};
