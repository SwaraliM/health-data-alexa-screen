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
    "#EC4899", // pink
    "#14B8A6", // teal
  ];

  const SLEEP_STAGE_COLORS = {
    Deep: "#3B82F6",
    Light: "#A78BFA",
    REM: "#06B6D4",
    Wake: "#FB923C",
  };
  
  // Recursive clone that preserves functions (needed for axis/tooltip formatters).
  const deepClone = (obj) => {
    if (typeof obj === "function") return obj;
    if (obj === null || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) return obj.map(deepClone);
    const clone = {};
    for (const key of Object.keys(obj)) clone[key] = deepClone(obj[key]);
    return clone;
  };
  
  const ensureArray = (v) => (Array.isArray(v) ? v : []);
  
  function applyPremiumHealthTheme(rawOption = {}, meta = {}) {
    const option = deepClone(rawOption);
    const palette = ensureArray(option.color).length ? ensureArray(option.color) : PALETTE;
  
    // Global defaults
    option.backgroundColor = option.backgroundColor ?? "transparent";
    option.color = palette;
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
      // Increased minimums to accommodate axis tick labels (fontSize 16) + axis names.
      // left: 90 gives room for the y-axis name (nameGap 58) to sit left of the tick numbers.
      const GRID_MINS = { left: 90, right: 36, top: 44, bottom: 68 };
      const grid = option.grid && typeof option.grid === "object" ? { ...option.grid } : {};
      grid.containLabel = true;
      grid.left = Math.max(Number(grid.left) || 0, GRID_MINS.left);
      grid.right = Math.max(Number(grid.right) || 0, GRID_MINS.right);
      grid.top = Math.max(Number(grid.top) || 0, GRID_MINS.top);
      grid.bottom = Math.max(Number(grid.bottom) || 0, GRID_MINS.bottom);
      option.grid = grid;
  
      // role: 'x' or 'y' — controls nameGap so names clear their respective tick labels
      const upgradeAxis = (axis, role = "x") => {
        if (!axis) return axis;
        const ax = deepClone(axis);
        ax.axisLine = ax.axisLine ?? { lineStyle: { color: "#CBD5E1", width: 2 } };
        ax.axisTick = ax.axisTick ?? { show: false };
        ax.splitLine = ax.splitLine ?? { lineStyle: { color: "#E2E8F0" } };
        ax.axisLabel = ax.axisLabel ?? {};
        ax.axisLabel.color = ax.axisLabel.color ?? "#1E293B";
        ax.axisLabel.fontSize = ax.axisLabel.fontSize ?? 16;
        ax.axisLabel.margin = ax.axisLabel.margin ?? 12;
        if (ax.name) {
          if (role === "y") {
            // 'middle' centres the name vertically along the axis.
            // nameGap 58 pushes it left of the tick number labels (which sit ~40px from the axis line).
            ax.nameLocation = ax.nameLocation ?? "middle";
            ax.nameGap = ax.nameGap ?? 58;
          } else {
            // 'middle' centres the name below the x-axis, away from the right-edge clip.
            ax.nameLocation = ax.nameLocation ?? "middle";
            ax.nameGap = ax.nameGap ?? 40;
          }
          ax.nameTextStyle = {
            fontSize: 14,
            fontWeight: 500,
            color: "#334155",
            ...ax.nameTextStyle,
          };
        }
        return ax;
      };
  
      if (Array.isArray(option.xAxis)) option.xAxis = option.xAxis.map((a) => upgradeAxis(a, "x"));
      else option.xAxis = upgradeAxis(option.xAxis, "x");
  
      if (Array.isArray(option.yAxis)) option.yAxis = option.yAxis.map((a) => upgradeAxis(a, "y"));
      else option.yAxis = upgradeAxis(option.yAxis, "y");
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
  
    const seriesArr = ensureArray(option.series);
    const hasMultipleSeries = seriesArr.length > 1;
    const hasPie = seriesArr.some((s) => s?.type === "pie");
    const hasStacked = seriesArr.some((s) => s?.stack);

    // Legend: pie charts hide the color-coded keys (legend)
    if (option.legend && hasPie) {
      option.legend = { ...option.legend, show: false };
    } else if (option.legend) {
      option.legend = {
        top: 8,
        textStyle: { fontSize: 15, color: "#334155" },
        ...option.legend,
      };
    }
    if (hasMultipleSeries && !option.legend) {
      option.legend = {
        top: 8,
        textStyle: { fontSize: 15, color: "#334155" },
      };
    }
    if (hasStacked && option.grid) {
      option.grid.top = Math.max(Number(option.grid.top) || 22, 42);
    }

    option.series = seriesArr.map((s = {}, idx) => {
      const series = deepClone(s);
      const type = series.type || "bar";
      const seriesColor = palette[idx % palette.length];
  
      if (type === "bar") {
        series.barMaxWidth = series.barMaxWidth ?? 44;
        series.itemStyle = series.itemStyle ?? {};
        series.itemStyle.color = series.itemStyle.color ?? seriesColor;
        series.itemStyle.borderRadius = series.itemStyle.borderRadius ?? [10, 10, 2, 2];
        series.itemStyle.shadowBlur = series.itemStyle.shadowBlur ?? 10;
        series.itemStyle.shadowColor = series.itemStyle.shadowColor ?? "rgba(15, 23, 42, 0.10)";
        series.label = series.label ?? {};
        series.label.show = series.label.show ?? true;
        series.label.position = series.label.position ?? "top";
        series.label.fontSize = series.label.fontSize ?? 14;
        series.label.color = series.label.color ?? "#0F172A";
      }
  
      if (type === "line") {
        series.smooth = series.smooth ?? true;
        series.showSymbol = series.showSymbol ?? true;
        series.symbol = series.symbol ?? "circle";
        series.symbolSize = series.symbolSize ?? 8;
        series.lineStyle = { width: 4, ...series.lineStyle };
        series.lineStyle.color = series.lineStyle.color ?? seriesColor;
        series.itemStyle = { ...series.itemStyle };
        series.itemStyle.color = series.itemStyle.color ?? seriesColor;
      }
  
      if (type === "pie") {
        series.radius = series.radius ?? ["40%", "72%"];
        series.avoidLabelOverlap = series.avoidLabelOverlap ?? true;
        series.itemStyle = series.itemStyle ?? { borderColor: "#fff", borderWidth: 2 };
        series.label = series.label ?? {};
        series.label.show = series.label.show ?? true;
        series.label.fontSize = series.label.fontSize ?? 16;
        series.label.color = series.label.color ?? "#0F172A";
      }
  
      if (type === "scatter") {
        series.symbolSize = series.symbolSize ?? 14;
        series.itemStyle = series.itemStyle ?? {};
        series.itemStyle.color = series.itemStyle.color ?? seriesColor;
        series.itemStyle.shadowBlur = series.itemStyle.shadowBlur ?? 8;
        series.itemStyle.shadowColor = series.itemStyle.shadowColor ?? "rgba(15, 23, 42, 0.12)";
        series.itemStyle.opacity = series.itemStyle.opacity ?? 0.85;
      }

      if (type === "bar" && series.stack) {
        series.barMaxWidth = series.barMaxWidth ?? 40;
        series.itemStyle = series.itemStyle ?? {};
        series.itemStyle.borderRadius = series.itemStyle.borderRadius ?? [0, 0, 0, 0];
        const stageName = series.name || "";
        if (SLEEP_STAGE_COLORS[stageName]) {
          series.itemStyle.color = series.itemStyle.color ?? SLEEP_STAGE_COLORS[stageName];
        }
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
        series.detail = series.detail ?? { fontSize: 34, color: "#0F172A", fontWeight: 700 };
        series.title = series.title ?? { fontSize: 14, color: "#334155" };
      }
  
      series.emphasis = series.emphasis ?? {};
      series.emphasis.focus = series.emphasis.focus ?? "series";
  
      return series;
    });
  
    return option;
  }
  
  export { applyPremiumHealthTheme, PALETTE, SLEEP_STAGE_COLORS };
  
