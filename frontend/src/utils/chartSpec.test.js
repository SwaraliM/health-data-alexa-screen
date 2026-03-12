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
