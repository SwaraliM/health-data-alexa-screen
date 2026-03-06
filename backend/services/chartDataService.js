/**
 * backend/services/chartDataService.js
 *
 * Pure Fitbit payload -> chart-friendly series helpers.
 *
 * These helpers normalize:
 * - daily/range metrics
 * - intraday activity
 * - intraday heart rate
 * - sleep stage breakdowns
 */

function asDateLabel(dateStr) {
  if (!dateStr) return "";
  const date = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(date.getTime())) return String(dateStr);
  return ["S", "M", "T", "W", "Th", "F", "S"][date.getDay()];
}

function asTimeLabel(timeStr) {
  if (!timeStr) return "";
  return String(timeStr).slice(0, 5); // HH:mm
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

    const mins = entry?.minutesAsleep ?? Math.round((entry?.duration || 0) / 60000);
    const current = byDate[date];

    if (!current || entry?.isMainSleep || mins > current.mins) {
      const levels = entry?.levels?.summary || {};
      byDate[date] = {
        mins: Number(mins) || 0,
        efficiency: Number(entry?.efficiency) || 0,
        wakeMinutes: Number(entry?.minutesAwake) || 0,
        deepMinutes: Number(levels?.deep?.minutes || 0),
        lightMinutes: Number(levels?.light?.minutes || 0),
        remMinutes: Number(levels?.rem?.minutes || 0),
        awakeStageMinutes: Number(levels?.wake?.minutes || 0),
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
      value: Number(byDate[date]?.wakeMinutes) || 0,
    })),
  };
}

function toSleepStageBreakdown(payload) {
  const logs = Array.isArray(payload?.sleep) ? payload.sleep : [];
  const main = logs.find((entry) => entry?.isMainSleep) || logs[0];
  const levels = main?.levels?.summary || {};

  const slices = [
    { name: "Deep", value: Number(levels?.deep?.minutes || 0) },
    { name: "Light", value: Number(levels?.light?.minutes || 0) },
    { name: "REM", value: Number(levels?.rem?.minutes || 0) },
    { name: "Awake", value: Number(levels?.wake?.minutes || 0) },
  ].filter((x) => x.value > 0);

  return slices.length ? slices : null;
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

function toIntradayHeartSeries(payload) {
  const dataset = Array.isArray(payload?.["activities-heart-intraday"]?.dataset)
    ? payload["activities-heart-intraday"].dataset
    : [];

  return dataset.map((item, idx) => ({
    date: null,
    label: asTimeLabel(item?.time) || String(idx + 1),
    fullLabel: item?.time || String(idx + 1),
    value: Number(item?.value) || 0,
  }));
}

function toIntradayActivitySeries(payload, resourceKey) {
  const key = `activities-${resourceKey}-intraday`;
  const dataset = Array.isArray(payload?.[key]?.dataset) ? payload[key].dataset : [];

  return dataset.map((item, idx) => ({
    date: null,
    label: asTimeLabel(item?.time) || String(idx + 1),
    fullLabel: item?.time || String(idx + 1),
    value: Number(item?.value) || 0,
  }));
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
  if (metricKey === "sleep_efficiency") return toSleepSeries(payload, maxPoints).efficiency;
  if (metricKey === "wake_minutes") return toSleepSeries(payload, maxPoints).wakeMinutes;

  if (metricKey === "resting_hr") return toHeartSeries(payload, maxPoints);
  if (metricKey === "heart_intraday") return toIntradayHeartSeries(payload);

  if (metricKey === "steps_intraday") return toIntradayActivitySeries(payload, "steps");
  if (metricKey === "calories_intraday") return toIntradayActivitySeries(payload, "calories");
  if (metricKey === "distance_intraday") return toIntradayActivitySeries(payload, "distance");
  if (metricKey === "floors_intraday") return toIntradayActivitySeries(payload, "floors");

  if (metricKey === "calories") return toSeriesFromResource(payload, "activities-calories", maxPoints);
  if (metricKey === "distance") return toSeriesFromResource(payload, "activities-distance", maxPoints);
  if (metricKey === "floors") return toSeriesFromResource(payload, "activities-floors", maxPoints);
  if (metricKey === "elevation") return toSeriesFromResource(payload, "activities-elevation", maxPoints);

  if (metricKey === "hrv") return toHrvSeries(payload, maxPoints);

  return toSeriesFromResource(payload, "activities-steps", maxPoints);
}

function sliceLast(points = [], count = 7) {
  return (Array.isArray(points) ? points : []).slice(-count);
}

module.exports = {
  asDateLabel,
  asTimeLabel,
  extractNumericValue,
  toSeriesFromResource,
  toSleepSeries,
  toSleepStageBreakdown,
  toHeartSeries,
  toIntradayHeartSeries,
  toIntradayActivitySeries,
  toHrvSeries,
  toMetricSeries,
  sliceLast,
};