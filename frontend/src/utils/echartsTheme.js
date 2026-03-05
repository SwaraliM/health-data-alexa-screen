/**
 * Premium Health Tech ECharts defaults (older-adult friendly).
 *
 * Goal: make *any* generated chart immediately readable:
 * - Bigger labels
 * - Higher contrast
 * - Rounded bars / smooth lines
 * - Clean grid and tooltip
 * - Colorful (per your preference), but not chaotic
 */

const PALETTE = [
    "#2563EB", // blue
    "#10B981", // green
    "#F59E0B", // amber
    "#EF4444", // red
    "#8B5CF6", // purple
    "#06B6D4", // cyan
    "#F97316", // orange
    "#22C55E", // lime
  ];
  
  const deepClone = (obj) => JSON.parse(JSON.stringify(obj || {}));
  
  const ensureArray = (v) => (Array.isArray(v) ? v : []);
  
  function applyPremiumHealthTheme(rawOption = {}, meta = {}) {
    const option = deepClone(rawOption);
  
    // Global defaults
    option.backgroundColor = option.backgroundColor ?? "transparent";
    option.color = ensureArray(option.color).length ? option.color : PALETTE;
    option.animationDuration = option.animationDuration ?? 650;
    option.animationEasing = option.animationEasing ?? "cubicOut";
  
    option.textStyle = {
      fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      fontSize: 14,
      color: "#0F172A",
      ...option.textStyle,
    };
  
    // Accessibility (ECharts AriaComponent must be enabled in echarts core setup)
    option.aria = {
      enabled: true,
      ...option.aria,
    };
  
    // Grid + axes (only apply if cartesian)
    if (option.xAxis || option.yAxis) {
      option.grid = option.grid ?? { left: 46, right: 24, top: 22, bottom: 42, containLabel: true };
  
      const upgradeAxis = (axis) => {
        if (!axis) return axis;
        const ax = deepClone(axis);
        ax.axisLine = ax.axisLine ?? { lineStyle: { color: "#CBD5E1", width: 2 } };
        ax.axisTick = ax.axisTick ?? { show: false };
        ax.splitLine = ax.splitLine ?? { lineStyle: { color: "#E2E8F0" } };
        ax.axisLabel = ax.axisLabel ?? {};
        ax.axisLabel.color = ax.axisLabel.color ?? "#334155";
        ax.axisLabel.fontSize = ax.axisLabel.fontSize ?? 14;
        ax.axisLabel.margin = ax.axisLabel.margin ?? 10;
        return ax;
      };
  
      if (Array.isArray(option.xAxis)) option.xAxis = option.xAxis.map(upgradeAxis);
      else option.xAxis = upgradeAxis(option.xAxis);
  
      if (Array.isArray(option.yAxis)) option.yAxis = option.yAxis.map(upgradeAxis);
      else option.yAxis = upgradeAxis(option.yAxis);
    }
  
    // Tooltip (important for "tap-to-understand")
    option.tooltip = option.tooltip ?? {};
    option.tooltip.trigger = option.tooltip.trigger ?? "axis";
    option.tooltip.backgroundColor = option.tooltip.backgroundColor ?? "rgba(15, 23, 42, 0.92)";
    option.tooltip.borderWidth = option.tooltip.borderWidth ?? 0;
    option.tooltip.textStyle = option.tooltip.textStyle ?? {};
    option.tooltip.textStyle.color = option.tooltip.textStyle.color ?? "#F8FAFC";
    option.tooltip.textStyle.fontSize = option.tooltip.textStyle.fontSize ?? 14;
    option.tooltip.extraCssText = option.tooltip.extraCssText ?? "border-radius: 12px; padding: 10px 12px;";
  
    // Legend (when present)
    if (option.legend) {
      option.legend = {
        top: 8,
        textStyle: { fontSize: 14, color: "#334155" },
        ...option.legend,
      };
    }
  
    // Series styling
    option.series = ensureArray(option.series).map((s = {}, idx) => {
      const series = deepClone(s);
      const type = series.type || "bar";
  
      if (type === "bar") {
        series.barMaxWidth = series.barMaxWidth ?? 44;
        series.itemStyle = series.itemStyle ?? {};
        series.itemStyle.borderRadius = series.itemStyle.borderRadius ?? [10, 10, 2, 2];
        series.itemStyle.shadowBlur = series.itemStyle.shadowBlur ?? 10;
        series.itemStyle.shadowColor = series.itemStyle.shadowColor ?? "rgba(15, 23, 42, 0.10)";
        series.label = series.label ?? {};
        series.label.show = series.label.show ?? true;
        series.label.position = series.label.position ?? "top";
        series.label.fontSize = series.label.fontSize ?? 13;
        series.label.color = series.label.color ?? "#0F172A";
      }
  
      if (type === "line") {
        series.smooth = series.smooth ?? true;
        series.showSymbol = series.showSymbol ?? false;
        series.symbol = series.symbol ?? "circle";
        series.symbolSize = series.symbolSize ?? 10;
        series.lineStyle = { width: 4, ...series.lineStyle };
        series.itemStyle = { ...series.itemStyle };
        // Soft area fill for readability
        series.areaStyle = series.areaStyle ?? { opacity: 0.12 };
      }
  
      if (type === "pie") {
        series.radius = series.radius ?? ["40%", "72%"];
        series.avoidLabelOverlap = series.avoidLabelOverlap ?? true;
        series.itemStyle = series.itemStyle ?? { borderColor: "#fff", borderWidth: 2 };
        series.label = series.label ?? {};
        series.label.show = series.label.show ?? true;
        series.label.fontSize = series.label.fontSize ?? 14;
        series.label.color = series.label.color ?? "#0F172A";
      }
  
      if (type === "gauge") {
        series.radius = series.radius ?? "92%";
        series.startAngle = series.startAngle ?? 200;
        series.endAngle = series.endAngle ?? -20;
        series.progress = series.progress ?? { show: true, width: 16 };
        series.axisLine = series.axisLine ?? { lineStyle: { width: 16 } };
        series.pointer = series.pointer ?? { show: false };
        series.axisTick = series.axisTick ?? { show: false };
        series.splitLine = series.splitLine ?? { show: false };
        series.axisLabel = series.axisLabel ?? { show: false };
        series.detail = series.detail ?? { fontSize: 28, color: "#0F172A", fontWeight: 700 };
        series.title = series.title ?? { fontSize: 14, color: "#334155" };
      }
  
      series.emphasis = series.emphasis ?? {};
      series.emphasis.focus = series.emphasis.focus ?? "series";
  
      return series;
    });
  
    return option;
  }
  
  export{ applyPremiumHealthTheme, PALETTE };
  