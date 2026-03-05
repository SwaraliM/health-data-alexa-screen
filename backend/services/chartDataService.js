/**
 * Pure Fitbit payload -> chart-friendly series helpers.
 *
 * These functions keep the payload small and predictable so the frontend only renders a few clear charts.
 */

function asDateLabel(dateStr) {
  if (!dateStr) return "";
  const date = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(date.getTime())) return String(dateStr);
  return ["S", "M", "T", "W", "Th", "F", "S"][date.getDay()];
}

function extractNumericValue(value) {
  if (Number.isFinite(Number(value))) return Number(value);
  if (!value || typeof value !== "object") return 0;
  for (const v of Object.values(value)) {
    if (Number.isFinite(Number(v))) return Number(v);
  }
  return 0;
}

function toSeriesFromResource(payload, resourceKey, maxPoints = 30) {
  const arr = Array.isArray(payload?.[resourceKey]) ? payload[resourceKey].slice(-maxPoints) : [];
  return arr.map((item, idx) => ({
    date: item?.dateTime || null,
    label: asDateLabel(item?.dateTime) || String(idx + 1),
    fullLabel: item?.dateTime || String(idx + 1),
    value: extractNumericValue(item?.value),
  }));
}

function toSleepSeries(payload, maxPoints = 30) {
  const logs = Array.isArray(payload?.sleep) ? payload.sleep : [];
  const byDate = {};

  logs.forEach((entry) => {
    const date = entry?.dateOfSleep || entry?.dateTime;
    if (!date) return;

    const current = byDate[date];
    const mins = entry?.minutesAsleep ?? Math.round((entry?.duration || 0) / 60000);
    if (!current || entry?.isMainSleep || mins > current.mins) {
      byDate[date] = {
        mins: Number(mins) || 0,
        efficiency: Number(entry?.efficiency) || 0,
        wakeCount: Number(entry?.minutesAwake) || 0,
      };
    }
  });

  const dates = Object.keys(byDate).sort().slice(-maxPoints);

  return {
    sleep: dates.map((date) => ({
      date,
      label: asDateLabel(date),
      fullLabel: date,
      value: Math.round(((byDate[date]?.mins || 0) / 60) * 10) / 10,
    })),
    efficiency: dates.map((date) => ({
      date,
      label: asDateLabel(date),
      fullLabel: date,
      value: Number(byDate[date]?.efficiency) || 0,
    })),
    wakeMinutes: dates.map((date) => ({
      date,
      label: asDateLabel(date),
      fullLabel: date,
      value: Number(byDate[date]?.wakeCount) || 0,
    })),
  };
}

function toHeartSeries(payload, maxPoints = 30) {
  const arr = Array.isArray(payload?.["activities-heart"]) ? payload["activities-heart"].slice(-maxPoints) : [];
  return arr
    .map((item) => ({
      date: item?.dateTime || null,
      label: asDateLabel(item?.dateTime),
      fullLabel: item?.dateTime || "",
      value: extractNumericValue(item?.value?.restingHeartRate ?? item?.value),
    }))
    .filter((item) => item.date && Number.isFinite(item.value));
}

function toHrvSeries(payload, maxPoints = 30) {
  const arr = Array.isArray(payload?.hrv)
    ? payload.hrv
    : Array.isArray(payload?.["activities-hrv"])
      ? payload["activities-hrv"]
      : [];

  return arr
    .slice(-maxPoints)
    .map((item) => ({
      date: item?.dateTime || item?.date || null,
      label: asDateLabel(item?.dateTime || item?.date),
      fullLabel: item?.dateTime || item?.date || "",
      value: extractNumericValue(item?.value?.dailyRmssd ?? item?.value?.rmssd ?? item?.value),
    }))
    .filter((item) => item.date && Number.isFinite(item.value));
}

function toMetricSeries(metricKey, payload, maxPoints = 30) {
  if (metricKey === "sleep_minutes") return toSleepSeries(payload, maxPoints).sleep;
  if (metricKey === "resting_hr") return toHeartSeries(payload, maxPoints);
  if (metricKey === "calories") return toSeriesFromResource(payload, "activities-calories", maxPoints);
  if (metricKey === "hrv") return toHrvSeries(payload, maxPoints);
  return toSeriesFromResource(payload, "activities-steps", maxPoints);
}

function sliceLast(points = [], count = 7) {
  return (Array.isArray(points) ? points : []).slice(-count);
}

module.exports = {
  asDateLabel,
  extractNumericValue,
  toSeriesFromResource,
  toSleepSeries,
  toHeartSeries,
  toHrvSeries,
  toMetricSeries,
  sliceLast,
};