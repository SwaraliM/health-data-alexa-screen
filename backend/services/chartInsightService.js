const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function toNumericSeries(points = []) {
  return (Array.isArray(points) ? points : [])
    .map((point, idx) => ({
      idx,
      label: String(point?.label ?? point?.date ?? idx + 1),
      date: point?.date || null,
      value: Number(point?.value),
    }))
    .filter((point) => Number.isFinite(point.value));
}

function calculateStats(points = [], goal = null) {
  const normalized = toNumericSeries(points);
  const values = normalized.map((point) => point.value);
  if (!values.length) {
    return { avg: 0, high: 0, low: 0, goal: goal ?? null, wowChangePct: 0 };
  }

  const avg = Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
  const high = Math.max(...values);
  const low = Math.min(...values);

  const half = Math.floor(values.length / 2);
  const prev = values.slice(0, half);
  const cur = values.slice(half);
  const prevAvg = prev.length ? prev.reduce((sum, value) => sum + value, 0) / prev.length : 0;
  const curAvg = cur.length ? cur.reduce((sum, value) => sum + value, 0) / cur.length : 0;
  const wowChangePct = prevAvg > 0 ? Math.round(((curAvg - prevAvg) / prevAvg) * 100) : 0;

  return {
    avg,
    high,
    low,
    goal: Number.isFinite(Number(goal)) ? Number(goal) : null,
    wowChangePct,
  };
}

function detectAnomalies(points = []) {
  const normalized = toNumericSeries(points);
  if (normalized.length < 5) return [];

  const values = normalized.map((point) => point.value);
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + ((value - avg) ** 2), 0) / values.length;
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

module.exports = {
  calculateStats,
  detectAnomalies,
};
