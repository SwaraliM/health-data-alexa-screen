import { validateChartSpec } from "./chartSpec";

test("heatmap validation preserves explicit visual map ranges", () => {
  const spec = validateChartSpec({
    chart_type: "heatmap",
    title: "Heatmap",
    option: {
      xAxis: { data: ["Mon", "Tue", "Wed"] },
      yAxis: { data: ["Steps"] },
      visualMap: {
        min: 10,
        max: 6000,
        inRange: { color: ["#E0F2FE", "#0EA5E9", "#0369A1"] },
      },
      series: [{ type: "heatmap", data: [[0, 0, 1200], [1, 0, 4200], [2, 0, 3100]] }],
    },
  }, "Heatmap");

  expect(spec.chart_type).toBe("heatmap");
  expect(spec.option.visualMap.min).toBe(10);
  expect(spec.option.visualMap.max).toBe(6000);
  expect(spec.option.visualMap.inRange.color).toEqual(["#E0F2FE", "#0EA5E9", "#0369A1"]);
  expect(spec.option.series[0].data).toHaveLength(3);
});

test("cartesian validation preserves series colors from the payload", () => {
  const spec = validateChartSpec({
    chart_type: "line",
    title: "Colored chart",
    option: {
      color: ["#2563EB", "#10B981", "#F59E0B"],
      xAxis: { data: ["Mon", "Tue", "Wed"] },
      yAxis: { type: "value" },
      series: [{
        type: "line",
        data: [1, 2, 3],
        itemStyle: { color: "#2563EB" },
        lineStyle: { color: "#2563EB" },
      }],
    },
  }, "Colored chart");

  expect(spec.option.color).toEqual(["#2563EB", "#10B981", "#F59E0B"]);
  expect(spec.option.series[0].itemStyle.color).toBe("#2563EB");
  expect(spec.option.series[0].lineStyle.color).toBe("#2563EB");
});

test("stacked sleep timelines keep bucket alignment and suppress bogus zero-only x-axis labels", () => {
  const spec = validateChartSpec({
    chart_type: "stacked_bar",
    title: "Sleep stages",
    option: {
      xAxis: { data: ["23:00", 0, "23:30", "", "00:00"] },
      yAxis: { type: "value", name: "minutes" },
      series: [
        { type: "bar", name: "Deep", data: [20, 0, 18, 0, 15] },
        { type: "bar", name: "Light", data: [35, 42, 40, 38, 34] },
      ],
    },
  }, "Sleep stages");

  expect(spec.chart_type).toBe("stacked_bar");
  expect(spec.option.xAxis.data).toEqual(["23:00", "", "23:30", "", "00:00"]);
  expect(spec.option.xAxis.axisLabel.hideOverlap).toBe(true);
});

test("line charts default to distinct point markers without implicit area fill", () => {
  const spec = validateChartSpec({
    chart_type: "line",
    title: "Heart rate trend",
    option: {
      xAxis: { data: ["Mon", "Tue", "Wed"] },
      yAxis: { type: "value" },
      series: [{ type: "line", data: [62, 64, 63] }],
    },
  }, "Heart rate trend");

  expect(spec.option.series[0].type).toBe("line");
  expect(spec.option.series[0].showSymbol).toBe(true);
  expect(spec.option.series[0].areaStyle).toBeUndefined();
});

test("sleep minute metrics are displayed in hours with axis and tooltip formatting", () => {
  const spec = validateChartSpec({
    chart_type: "line",
    title: "Sleep duration trend",
    option: {
      xAxis: { data: ["10:00 PM", "11:00 PM", "12:00 AM"] },
      yAxis: { type: "value", name: "minutes" },
      series: [{ type: "line", name: "sleep_minutes", data: [420, 450, 390] }],
    },
  }, "Sleep duration trend");

  expect(spec.option.xAxis.name).toBe("Time");
  expect(spec.option.yAxis.name).toBe("Hours");
  expect(spec.option.series[0].data).toEqual([7, 7.5, 6.5]);
});

test("sleep y-axis formatter displays decimal hours as 'x h y min'", () => {
  // Backend sends yAxis.name "minutes" + series named after a sleep metric
  const spec = validateChartSpec({
    chart_type: "bar",
    title: "Sleep duration",
    option: {
      xAxis: { data: ["Mon", "Tue", "Wed", "Thu"] },
      yAxis: { type: "value", name: "minutes" },
      series: [{ type: "bar", name: "sleep_minutes", data: [480, 450, 390, 510] }],
    },
  }, "Sleep duration");

  const fmt = spec.option.yAxis.axisLabel?.formatter;
  expect(typeof fmt).toBe("function");
  // 480 min → 8.0 h → "8 h"
  expect(fmt(8)).toBe("8 h");
  // 450 min → 7.5 h → "7 h 30 min"
  expect(fmt(7.5)).toBe("7 h 30 min");
  // 390 min → 6.5 h → "6 h 30 min"
  expect(fmt(6.5)).toBe("6 h 30 min");
  // 7.2 h → "7 h 12 min"
  expect(fmt(7.2)).toBe("7 h 12 min");

  // Tooltip valueFormatter should match
  const tooltipFmt = spec.option.tooltip?.valueFormatter;
  expect(typeof tooltipFmt).toBe("function");
  expect(tooltipFmt(7.5)).toBe("7 h 30 min");

  // Bar label formatter should also use "x h y min"
  const labelFmt = spec.option.series[0].label?.formatter;
  expect(typeof labelFmt).toBe("function");
  expect(labelFmt({ value: 8 })).toBe("8 h");
  expect(labelFmt({ value: 7.5 })).toBe("7 h 30 min");
  expect(labelFmt({ value: 7.2 })).toBe("7 h 12 min");
});

test("sleep data already in hours is not double-converted when title contains 'minutes'", () => {
  // Simulates a chart that was already converted: data in decimal hours, yAxis "Hours",
  // but the chart title still says "Sleep Minutes".
  const spec = validateChartSpec({
    chart_type: "bar",
    title: "Sleep Minutes — Last 7 Days",
    option: {
      xAxis: { data: ["Mon", "Tue", "Wed"] },
      yAxis: { type: "value", name: "Hours" },
      series: [{ type: "bar", name: "sleep_minutes", data: [7.0, 7.5, 6.5] }],
    },
  }, "Sleep Minutes — Last 7 Days");

  // Values must stay as-is — dividing by 60 would give ~0.12 ("0 h 7 min")
  expect(spec.option.series[0].data).toEqual([7.0, 7.5, 6.5]);
  // No formatter should be applied (data is already in hours, no conversion)
  expect(spec.option.yAxis.axisLabel?.formatter).toBeUndefined();
});

test("cartesian charts get default axis labels when names are omitted", () => {
  const spec = validateChartSpec({
    chart_type: "grouped_bar",
    title: "Weekly activity",
    option: {
      xAxis: { data: ["Mon", "Tue", "Wed"] },
      yAxis: { type: "value" },
      series: [{ type: "bar", name: "Steps", data: [6000, 6500, 6200] }],
    },
  }, "Weekly activity");

  expect(spec.option.xAxis.name).toBe("Date");
  expect(spec.option.yAxis.name).toBe("Value");
});
