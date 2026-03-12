const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildEstimatedIntradaySeries,
  getIntradayAvailability,
  toIntradayActivitySeries,
} = require("../services/chartDataService");

test("toIntradayActivitySeries reads Fitbit intraday datasets", () => {
  const points = toIntradayActivitySeries({
    "activities-steps-intraday": {
      dataset: [
        { time: "06:00:00", value: 120 },
        { time: "12:00:00", value: 860 },
      ],
    },
  }, "steps");

  assert.deepEqual(points, [
    { date: null, label: "06:00", fullLabel: "06:00:00", value: 120 },
    { date: null, label: "12:00", fullLabel: "12:00:00", value: 860 },
  ]);
});

test("getIntradayAvailability marks summary-only activity payloads", () => {
  const availability = getIntradayAvailability("steps_intraday", {
    "activities-steps": [{ dateTime: "2026-03-09", value: "6400" }],
  });

  assert.equal(availability.status, "summary_only");
  assert.match(availability.reason, /daily summary data/i);
});

test("buildEstimatedIntradaySeries generates coarse estimated buckets from summary data", () => {
  const points = buildEstimatedIntradaySeries({
    metricKey: "steps_intraday",
    date: "2026-03-09",
    activitySummaryPayload: {
      summary: {
        steps: 6400,
        lightlyActiveMinutes: 90,
        fairlyActiveMinutes: 22,
        veryActiveMinutes: 8,
      },
      activities: [
        { startTime: "12:15", duration: 1800000, steps: 1800, calories: 160 },
        { startTime: "18:10", duration: 2400000, steps: 2200, calories: 210 },
      ],
    },
  });

  assert.equal(points.length, 4);
  assert.ok(points.every((point) => point.isSynthetic === true));
  assert.equal(points[0].label, "06:00");
  assert.ok(points.reduce((sum, point) => sum + point.value, 0) > 6000);
});
