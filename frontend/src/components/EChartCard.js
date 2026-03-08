import React, { useCallback, useEffect, useMemo, useRef } from "react";
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
  const chartRef = useRef(null);
  const wrapRef = useRef(null);
  const safeSpec = useMemo(() => {
    if (!chartSpec) return fallbackChartSpec("Your Health Data");
    return validateChartSpec(chartSpec, chartSpec?.title || "Your Health Data");
  }, [chartSpec]);

  const resizeChart = useCallback(() => {
    if (chartRef.current?.resize) chartRef.current.resize();
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame ? window.requestAnimationFrame(resizeChart) : setTimeout(resizeChart, 0);
    window.addEventListener("resize", resizeChart);
    return () => {
      if (window.cancelAnimationFrame && typeof frame === "number") window.cancelAnimationFrame(frame);
      else clearTimeout(frame);
      window.removeEventListener("resize", resizeChart);
    };
  }, [resizeChart, safeSpec, className]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => resizeChart());
    ro.observe(el);
    return () => ro.disconnect();
  }, [resizeChart]);

  return (
    <div
      ref={wrapRef}
      className={`hd-echart-wrap ${className}`.trim()}
      aria-label={safeSpec.title || "Health chart"}
      role="img"
    >
      <ReactECharts
        option={safeSpec.option || {}}
        notMerge
        lazyUpdate
        style={{ width: "100%", height: "100%", minHeight: "100%", flex: 1 }}
        className="hd-echart"
        opts={{ renderer: "canvas" }}
        onChartReady={(instance) => {
          chartRef.current = instance || null;
          chartRef.current?.resize?.();
        }}
      />
    </div>
  );
};

export default EChartCard;
