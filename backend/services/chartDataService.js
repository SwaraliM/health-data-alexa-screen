/**
 * backend/services/chartDataService.js
 *
 * Pure Fitbit payload -> chart-friendly series helpers.
 *
 * Backward compatible with the current qnaEngine, but also exposes richer
 * helpers for future progressive drill-downs:
 * - sleep timing summary
 * - sleep stage composition
 * - sleep stage timeline segments
 * - intraday bucket aggregation
 * - generic multi-series window summaries
 */

function asDateLabel(dateStr) {
  if (!dateStr) return "";
  const date = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(date.getTime())) return String(dateStr);
  return ["S", "M", "T", "W", "Th", "F", "S"][date.getDay()];
}

function asTimeLabel(timeStr) {
  if (!timeStr) return "";
  return String(timeStr).slice(0, 5);
}

function extractNumericValue(value) {
  if (Number.isFinite(Number(value))) return Number(value);
  if (!value || typeof value !== "object") return 0;
  for (const v of Object.values(value)) {
    if (Number.isFinite(Number(v))) return Number(v);
  }
  return 0;
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round1(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0;
}

function minutesToHours(minutes) {
  return round1(safeNumber(minutes, 0) / 60);
}

function parseIsoDateTime(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function minutesFromClockString(timeStr) {
  const text = String(timeStr || "").slice(0, 5);
  const [h, m] = text.split(":").map((v) => Number(v));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return (h * 60) + m;
}

function clockLabelFromMinutes(totalMinutes) {
  if (!Number.isFinite(totalMinutes)) return "";
  const normalized = ((Math.round(totalMinutes) % 1440) + 1440) % 1440;
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function clockLabelFromDateTime(value) {
  const date = value instanceof Date ? value : parseIsoDateTime(value);
  if (!date) return "";
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return seconds === "00" ? `${hours}:${minutes}` : `${hours}:${minutes}:${seconds}`;
}

function normalizeSleepLevel(level) {
  const raw = String(level || "").toLowerCase();
  if (["deep", "light", "rem", "wake", "awake"].includes(raw)) {
    return raw === "awake" ? "wake" : raw;
  }
  if (raw === "restless") return "wake";
  if (raw === "asleep") return "light";
  return raw || "unknown";
}

function pickMainSleepLog(payload) {
  const logs = Array.isArray(payload?.sleep) ? payload.sleep : [];
  return logs.find((entry) => entry?.isMainSleep) || logs[0] || null;
}

function sleepStageLabel(stage) {
  const normalized = normalizeSleepLevel(stage);
  if (normalized === "wake") return "Awake";
  if (normalized === "rem") return "REM";
  if (!normalized) return "Unknown";
  return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
}

function collectSleepLevelEntries(mainSleepLog) {
  if (!mainSleepLog) return [];
  const pointMap = new Map();
  const ingest = (entries = [], priority = 0) => {
    (Array.isArray(entries) ? entries : []).forEach((entry) => {
      const timestamp = parseIsoDateTime(entry?.dateTime);
      const seconds = safeNumber(entry?.seconds);
      const stage = normalizeSleepLevel(entry?.level);
      if (!timestamp || !seconds || !stage || stage === "unknown") return;
      const key = timestamp.toISOString();
      const current = pointMap.get(key);
      if (!current || priority >= current.priority) {
        pointMap.set(key, {
          timestamp,
          seconds,
          stage,
          priority,
        });
      }
    });
  };

  // Fitbit shortData usually carries wake/restless intervals that should override base level data.
  ingest(mainSleepLog?.levels?.data, 1);
  ingest(mainSleepLog?.levels?.shortData, 2);

  return [...pointMap.values()].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
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
        mins: safeNumber(mins),
        efficiency: safeNumber(entry?.efficiency),
        wakeMinutes: safeNumber(entry?.minutesAwake),
        deepMinutes: safeNumber(levels?.deep?.minutes),
        lightMinutes: safeNumber(levels?.light?.minutes),
        remMinutes: safeNumber(levels?.rem?.minutes),
        awakeStageMinutes: safeNumber(levels?.wake?.minutes),
        timeInBed: safeNumber(entry?.timeInBed),
        minutesToFallAsleep: safeNumber(entry?.minutesToFallAsleep),
        minutesAfterWakeup: safeNumber(entry?.minutesAfterWakeup),
        startTime: entry?.startTime || null,
        endTime: entry?.endTime || null,
      };
    }
  });

  const dates = Object.keys(byDate).sort().slice(-maxPoints);

  return {
    sleep: dates.map((date) => ({
      date,
      label: asDateLabel(date),
      fullLabel: date,
      value: minutesToHours(byDate[date]?.mins || 0),
    })),
    efficiency: dates.map((date) => {
      const row = byDate[date];
      let eff = safeNumber(row?.efficiency);
      if (!eff && row?.timeInBed > 0 && (row?.mins != null || row?.mins === 0)) {
        eff = round1((safeNumber(row.mins) / row.timeInBed) * 100);
      }
      return {
        date,
        label: asDateLabel(date),
        fullLabel: date,
        value: eff,
      };
    }),
    wakeMinutes: dates.map((date) => ({
      date,
      label: asDateLabel(date),
      fullLabel: date,
      value: safeNumber(byDate[date]?.wakeMinutes),
    })),
    timeInBed: dates.map((date) => ({
      date,
      label: asDateLabel(date),
      fullLabel: date,
      value: safeNumber(byDate[date]?.timeInBed),
    })),
    sleepLatency: dates.map((date) => ({
      date,
      label: asDateLabel(date),
      fullLabel: date,
      value: safeNumber(byDate[date]?.minutesToFallAsleep),
    })),
    bedtimeClock: dates.map((date) => {
      const start = parseIsoDateTime(byDate[date]?.startTime);
      const bedtimeMinutes = start ? (start.getHours() * 60) + start.getMinutes() : null;
      return {
        date,
        label: asDateLabel(date),
        fullLabel: date,
        value: bedtimeMinutes == null ? 0 : bedtimeMinutes,
        clockLabel: bedtimeMinutes == null ? "" : clockLabelFromMinutes(bedtimeMinutes),
      };
    }),
  };
}

function toSleepStageBreakdown(payload) {
  const main = pickMainSleepLog(payload);
  const levels = main?.levels?.summary || {};

  const slices = [
    { name: "Deep", value: safeNumber(levels?.deep?.minutes) },
    { name: "Light", value: safeNumber(levels?.light?.minutes) },
    { name: "REM", value: safeNumber(levels?.rem?.minutes) },
    { name: "Awake", value: safeNumber(levels?.wake?.minutes) },
  ].filter((x) => x.value > 0);

  return slices.length ? slices : null;
}

function toSleepStageComparison(payload) {
  const main = pickMainSleepLog(payload);
  const levels = main?.levels?.summary || {};
  const stageOrder = ["deep", "light", "rem", "wake"];
  const rows = stageOrder.map((stage) => {
    const summary = levels?.[stage] || {};
    const minutes = safeNumber(summary?.minutes);
    const thirtyDayAvgMinutes = safeNumber(summary?.thirtyDayAvgMinutes);
    return {
      stage: stage === "wake" ? "Awake" : stage.toUpperCase() === "REM" ? "REM" : `${stage.charAt(0).toUpperCase()}${stage.slice(1)}`,
      currentMinutes: minutes,
      baselineMinutes: thirtyDayAvgMinutes,
      differenceMinutes: round1(minutes - thirtyDayAvgMinutes),
    };
  }).filter((row) => row.currentMinutes > 0 || row.baselineMinutes > 0);

  return rows.length ? rows : null;
}

function toSleepStageTrendSeries(payload, maxPoints = 14) {
  const logs = Array.isArray(payload?.sleep) ? payload.sleep : [];
  const stageMap = {};

  logs.forEach((entry) => {
    const date = entry?.dateOfSleep || entry?.dateTime;
    if (!date) return;
    const levels = entry?.levels?.summary || {};
    const totalMinutes = safeNumber(entry?.minutesAsleep, Math.round(safeNumber(entry?.duration) / 60000));
    const current = stageMap[date];
    if (!current || entry?.isMainSleep || totalMinutes > current.totalMinutes) {
      stageMap[date] = {
        totalMinutes,
        deep: safeNumber(levels?.deep?.minutes),
        light: safeNumber(levels?.light?.minutes),
        rem: safeNumber(levels?.rem?.minutes),
        wake: safeNumber(levels?.wake?.minutes),
      };
    }
  });

  const dates = Object.keys(stageMap).sort().slice(-maxPoints);
  if (!dates.length) return null;

  const makeSeries = (key) => dates.map((date) => ({
    date,
    label: asDateLabel(date),
    fullLabel: date,
    value: round1(stageMap[date]?.[key] || 0),
  }));

  return {
    deep: makeSeries("deep"),
    light: makeSeries("light"),
    rem: makeSeries("rem"),
    wake: makeSeries("wake"),
  };
}

function toSleepTimingSummary(payload) {
  const main = pickMainSleepLog(payload);
  if (!main) return null;

  const start = parseIsoDateTime(main?.startTime);
  const end = parseIsoDateTime(main?.endTime);
  const bedtimeMinutes = start ? (start.getHours() * 60) + start.getMinutes() : null;
  const wakeMinutes = end ? (end.getHours() * 60) + end.getMinutes() : null;

  return {
    date: main?.dateOfSleep || main?.dateTime || null,
    startTime: main?.startTime || null,
    endTime: main?.endTime || null,
    bedtimeMinutes,
    wakeMinutes,
    bedtimeLabel: bedtimeMinutes == null ? "" : clockLabelFromMinutes(bedtimeMinutes),
    wakeLabel: wakeMinutes == null ? "" : clockLabelFromMinutes(wakeMinutes),
    minutesAsleep: safeNumber(main?.minutesAsleep, Math.round(safeNumber(main?.duration) / 60000)),
    timeInBed: safeNumber(main?.timeInBed),
    efficiency: safeNumber(main?.efficiency),
    minutesAwake: safeNumber(main?.minutesAwake),
    minutesToFallAsleep: safeNumber(main?.minutesToFallAsleep),
    minutesAfterWakeup: safeNumber(main?.minutesAfterWakeup),
  };
}

function toSleepStageTimeline(payload, bucketMinutes = 15) {
  const main = pickMainSleepLog(payload);
  if (!main) return null;
  const rawData = collectSleepLevelEntries(main);
  if (!rawData.length) return null;

  const bucketMap = new Map();
  rawData.forEach((entry) => {
    const timestamp = entry?.timestamp instanceof Date ? entry.timestamp : parseIsoDateTime(entry?.dateTime);
    const seconds = safeNumber(entry?.seconds);
    if (!timestamp || !seconds) return;
    const minutes = seconds / 60;
    const bucketStartMinutes = Math.floor((timestamp.getHours() * 60 + timestamp.getMinutes()) / bucketMinutes) * bucketMinutes;
    const key = `${timestamp.toISOString().slice(0, 10)}|${bucketStartMinutes}`;
    const stage = normalizeSleepLevel(entry?.stage || entry?.level);
    const existing = bucketMap.get(key) || {
      date: timestamp.toISOString().slice(0, 10),
      bucketStartMinutes,
      clockLabel: clockLabelFromMinutes(bucketStartMinutes),
      stages: {},
    };
    existing.stages[stage] = safeNumber(existing.stages[stage]) + minutes;
    bucketMap.set(key, existing);
  });

  const ordered = [...bucketMap.values()].sort((a, b) => {
    const ak = `${a.date}|${String(a.bucketStartMinutes).padStart(4, "0")}`;
    const bk = `${b.date}|${String(b.bucketStartMinutes).padStart(4, "0")}`;
    return ak.localeCompare(bk);
  });

  return ordered.map((bucket) => {
    const stages = bucket.stages || {};
    const dominant = Object.entries(stages).sort((a, b) => b[1] - a[1])[0]?.[0] || "unknown";
    return {
      date: bucket.date,
      label: bucket.clockLabel,
      fullLabel: `${bucket.date} ${bucket.clockLabel}`,
      value: stages[dominant] || 0,
      stage: dominant,
      stageMinutes: stages,
    };
  });
}

function toSleepStageSegments(payload) {
  const main = pickMainSleepLog(payload);
  if (!main) return null;

  const entries = collectSleepLevelEntries(main);
  if (!entries.length) return null;

  const segments = [];
  entries.forEach((entry) => {
    const startMs = entry.timestamp.getTime();
    const endMs = startMs + (safeNumber(entry.seconds) * 1000);
    const last = segments[segments.length - 1];

    if (last && last.stage === entry.stage && last.endMs === startMs) {
      last.endMs = endMs;
      last.seconds += safeNumber(entry.seconds);
      last.minutes = round1(last.seconds / 60);
      last.endTime = new Date(endMs).toISOString();
      last.endLabel = clockLabelFromDateTime(new Date(endMs));
      return;
    }

    segments.push({
      date: entry.timestamp.toISOString().slice(0, 10),
      stage: entry.stage,
      stageLabel: sleepStageLabel(entry.stage),
      startMs,
      endMs,
      startTime: entry.timestamp.toISOString(),
      endTime: new Date(endMs).toISOString(),
      startLabel: clockLabelFromDateTime(entry.timestamp),
      endLabel: clockLabelFromDateTime(new Date(endMs)),
      seconds: safeNumber(entry.seconds),
      minutes: round1(safeNumber(entry.seconds) / 60),
    });
  });

  return segments.map(({ startMs: _startMs, endMs: _endMs, ...segment }) => segment);
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
    value: safeNumber(item?.value),
  }));
}

function toIntradayActivitySeries(payload, resourceKey) {
  const key = `activities-${resourceKey}-intraday`;
  const dataset = Array.isArray(payload?.[key]?.dataset) ? payload[key].dataset : [];

  return dataset.map((item, idx) => ({
    date: null,
    label: asTimeLabel(item?.time) || String(idx + 1),
    fullLabel: item?.time || String(idx + 1),
    value: safeNumber(item?.value),
  }));
}

function bucketIntradaySeries(points = [], bucketMinutes = 60) {
  const buckets = new Map();
  (Array.isArray(points) ? points : []).forEach((point) => {
    const minuteOfDay = minutesFromClockString(point?.fullLabel || point?.label);
    if (minuteOfDay == null) return;
    const bucketStart = Math.floor(minuteOfDay / bucketMinutes) * bucketMinutes;
    const key = bucketStart;
    const current = buckets.get(key) || {
      minuteOfDay: bucketStart,
      label: clockLabelFromMinutes(bucketStart),
      fullLabel: clockLabelFromMinutes(bucketStart),
      value: 0,
      count: 0,
      max: null,
      min: null,
    };
    const value = safeNumber(point?.value);
    current.value += value;
    current.count += 1;
    current.max = current.max == null ? value : Math.max(current.max, value);
    current.min = current.min == null ? value : Math.min(current.min, value);
    buckets.set(key, current);
  });

  return [...buckets.values()]
    .sort((a, b) => a.minuteOfDay - b.minuteOfDay)
    .map((bucket) => ({
      ...bucket,
      avgValue: bucket.count ? round1(bucket.value / bucket.count) : 0,
    }));
}

function summarizeIntradayWindows(points = [], bucketMinutes = 180) {
  const bucketed = bucketIntradaySeries(points, bucketMinutes);
  if (!bucketed.length) return null;
  const strongest = [...bucketed].sort((a, b) => b.value - a.value)[0];
  const quietest = [...bucketed].sort((a, b) => a.value - b.value)[0];
  const takeaway = strongest
    ? `${strongest.label} was the strongest part of the day.`
    : "This shows how the day was distributed.";
  return {
    takeaway,
    strongestWindow: strongest ? { label: strongest.label, total: round1(strongest.value), average: strongest.avgValue } : null,
    quietestWindow: quietest ? { label: quietest.label, total: round1(quietest.value), average: quietest.avgValue } : null,
    windows: bucketed,
    buckets: bucketed.map((bucket) => ({
      label: bucket.label,
      value: round1(bucket.value),
      average: bucket.avgValue,
    })),
  };
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

function toBreathingRateSeries(payload, maxPoints = 30) {
  const arr = Array.isArray(payload?.br)
    ? payload.br
    : Array.isArray(payload?.["breathing-rate"])
      ? payload["breathing-rate"]
      : [];

  return arr
    .slice(-maxPoints)
    .map((item) => {
      const date = item?.dateTime || item?.date || null;
      return {
        date,
        label: asDateLabel(date),
        fullLabel: date || "",
        value: extractNumericValue(item?.value?.breathingRate ?? item?.value?.value ?? item?.value),
      };
    })
    .filter((item) => item.date && Number.isFinite(item.value));
}

function toSpo2Series(payload, maxPoints = 30) {
  const arr = Array.isArray(payload?.spo2)
    ? payload.spo2
    : Array.isArray(payload?.["oxygen-saturation"])
      ? payload["oxygen-saturation"]
      : [];

  return arr
    .slice(-maxPoints)
    .map((item) => {
      const date = item?.dateTime || item?.date || null;
      return {
        date,
        label: asDateLabel(date),
        fullLabel: date || "",
        value: extractNumericValue(item?.value?.avg ?? item?.value?.spo2 ?? item?.value?.value ?? item?.value),
      };
    })
    .filter((item) => item.date && Number.isFinite(item.value));
}

function toBodyLogSeries(payload, resourceKey, maxPoints = 30) {
  const arr = Array.isArray(payload?.[resourceKey])
    ? payload[resourceKey]
    : Array.isArray(payload?.[`body-${resourceKey}`])
      ? payload[`body-${resourceKey}`]
      : [];

  return arr
    .slice(-maxPoints)
    .map((item) => {
      const date = item?.dateTime || item?.date || item?.logDate || null;
      const resourceValue = resourceKey === "weight"
        ? item?.weight ?? item?.value?.weight
        : item?.fat ?? item?.value?.fat;
      return {
        date,
        label: asDateLabel(date),
        fullLabel: date || "",
        value: extractNumericValue(resourceValue ?? item?.value),
      };
    })
    .filter((item) => item.date && Number.isFinite(item.value));
}

function toMetricSeries(metricKey, payload, maxPoints = 30) {
  if (metricKey === "sleep_minutes") return toSleepSeries(payload, maxPoints).sleep;
  if (metricKey === "sleep_efficiency") return toSleepSeries(payload, maxPoints).efficiency;
  if (metricKey === "wake_minutes") return toSleepSeries(payload, maxPoints).wakeMinutes;
  if (metricKey === "breathing_rate") return toBreathingRateSeries(payload, maxPoints);
  if (metricKey === "spo2") return toSpo2Series(payload, maxPoints);
  if (metricKey === "weight") return toBodyLogSeries(payload, "weight", maxPoints);
  if (metricKey === "body_fat") return toBodyLogSeries(payload, "fat", maxPoints);

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

function toComparableMetricBundle(payload, metricKey, maxPoints = 30) {
  const series = toMetricSeries(metricKey, payload, maxPoints);
  const latest = series[series.length - 1] || null;
  return {
    metricKey,
    series,
    latestValue: latest?.value ?? null,
    latestLabel: latest?.label || latest?.fullLabel || "",
  };
}

function toMultiMetricBundle(payloadMap = {}, metricKeys = [], maxPoints = 30) {
  return (Array.isArray(metricKeys) ? metricKeys : [])
    .filter(Boolean)
    .map((metricKey) => toComparableMetricBundle(payloadMap?.[metricKey] || payloadMap, metricKey, maxPoints));
}

function sliceLast(points = [], count = 7) {
  return (Array.isArray(points) ? points : []).slice(-count);
}

module.exports = {
  asDateLabel,
  asTimeLabel,
  extractNumericValue,
  safeNumber,
  round1,
  minutesToHours,
  minutesFromClockString,
  clockLabelFromMinutes,
  clockLabelFromDateTime,
  normalizeSleepLevel,
  pickMainSleepLog,
  toSleepStageSegments,
  toSeriesFromResource,
  toSleepSeries,
  toSleepStageBreakdown,
  toSleepStageComparison,
  toSleepStageTrendSeries,
  toSleepTimingSummary,
  toSleepStageTimeline,
  toHeartSeries,
  toIntradayHeartSeries,
  toIntradayActivitySeries,
  bucketIntradaySeries,
  summarizeIntradayWindows,
  toHrvSeries,
  toBreathingRateSeries,
  toSpo2Series,
  toBodyLogSeries,
  toMetricSeries,
  toComparableMetricBundle,
  toMultiMetricBundle,
  sliceLast,
};
