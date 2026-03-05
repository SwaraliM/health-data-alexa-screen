import React, { useMemo } from "react";
import ReactECharts from "echarts-for-react";
import { fallbackChartSpec, validateChartSpec } from "../utils/chartSpec";

/**
 * ECharts renderer for the QnA page.
 *
 * This component renders one validated chart_spec option object.
 * It keeps rendering deterministic: no arbitrary component trees from GPT.
 *
 * We use the installed `echarts` + `echarts-for-react` packages directly.
 */
const EChartCard = ({ chartSpec, className = "" }) => {
  const safeSpec = useMemo(() => {
    if (!chartSpec) return fallbackChartSpec("Your Health Data");
    return validateChartSpec(chartSpec, chartSpec?.title || "Your Health Data");
  }, [chartSpec]);

  return (
    <div
      className={`hd-echart-wrap ${className}`.trim()}
      aria-label={safeSpec.title || "Health chart"}
      role="img"
    >
      <ReactECharts
        option={safeSpec.option || {}}
        notMerge
        lazyUpdate
        style={{ width: "100%", height: "100%" }}
        className="hd-echart"
        opts={{ renderer: "canvas" }}
      />
    </div>
  );
};

export default EChartCard;
