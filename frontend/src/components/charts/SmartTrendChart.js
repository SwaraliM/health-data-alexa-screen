import React, { useMemo, useState } from "react";

const defaultSpec = {
  type: "line",
  showGoalLine: false,
  goalLineValue: null,
  anomalies: [],
  interactions: { pointSelect: false, rangeSelect: false, anomalySelect: false },
};

const SmartTrendChart = ({
  series = [],
  spec = defaultSpec,
  unit = "",
  ariaLabel = "Health trend chart",
  selectedRange = null,
  onPointSelect,
  onRangeSelect,
  onAnomalySelect,
  colorStroke = "#3b82f6",
  colorFill = "rgba(59,130,246,0.14)",
  colorBar = "#3b82f6",
}) => {
  const [anchorIndex, setAnchorIndex] = useState(null);
  const [hoveredIndex, setHoveredIndex] = useState(null);

  const points = useMemo(
    () => (Array.isArray(series) ? series : []).filter((p) => Number.isFinite(Number(p?.value))),
    [series]
  );

  const mergedSpec = { ...defaultSpec, ...(spec || {}), interactions: { ...defaultSpec.interactions, ...(spec?.interactions || {}) } };

  if (!points.length) {
    return <div className="ss-smart-chart-empty" style={{ fontSize: 20, padding: 32, textAlign: "center", color: "#64748b" }}>No chart data available.</div>;
  }

  const width = 960;
  const height = 340;
  const leftPad = 72;
  const rightPad = 24;
  const topPad = 28;
  const bottomPad = 56;
  const drawWidth = width - leftPad - rightPad;
  const drawHeight = height - topPad - bottomPad;

  const values = points.map((p) => Number(p.value));
  const maxValue = Math.max(...values, Number(mergedSpec.goalLineValue) || 0, 1);
  const minValue = Math.min(...values, 0);
  const range = Math.max(1, maxValue - minValue);

  const mapX = (i) => leftPad + (i * drawWidth) / Math.max(points.length - 1, 1);
  const mapY = (v) => topPad + drawHeight - ((v - minValue) / range) * drawHeight;

  const yTicks = 5;
  const yLabels = Array.from({ length: yTicks }, (_, i) => {
    const v = minValue + (range * i) / (yTicks - 1);
    return { v, y: mapY(v), label: Math.round(v).toLocaleString() };
  });

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${mapX(i)} ${mapY(Number(p.value))}`).join(" ");
  const areaPath = `${linePath} L ${mapX(points.length - 1)} ${topPad + drawHeight} L ${mapX(0)} ${topPad + drawHeight} Z`;

  const selStart = selectedRange ? Math.max(0, Math.min(selectedRange.startIndex, selectedRange.endIndex)) : null;
  const selEnd = selectedRange ? Math.min(points.length - 1, Math.max(selectedRange.startIndex, selectedRange.endIndex)) : null;

  const bars = points.map((p, i) => {
    const x = mapX(i);
    const y = mapY(Number(p.value));
    const w = Math.max(10, drawWidth / Math.max(points.length * 1.5, 1));
    const h = topPad + drawHeight - y;
    return { x, y, w, h, i, p };
  });

  const onTap = (i, p) => {
    if (mergedSpec.interactions.rangeSelect) {
      if (anchorIndex == null) {
        setAnchorIndex(i);
      } else {
        onRangeSelect?.({ startIndex: anchorIndex, endIndex: i, start: points[Math.min(anchorIndex, i)], end: points[Math.max(anchorIndex, i)] });
        setAnchorIndex(null);
      }
    }
    if (mergedSpec.interactions.pointSelect) onPointSelect?.({ index: i, point: p });
  };

  const dotR = 7;

  return (
    <div className="ss-smart-chart-wrap">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="ss-smart-chart"
        role="img"
        aria-label={ariaLabel}
        style={{ display: "block", width: "100%", height: "auto" }}
      >
        {/* horizontal grid lines */}
        {yLabels.map((t, i) => (
          <line key={`grid-${i}`} x1={leftPad} x2={leftPad + drawWidth} y1={t.y} y2={t.y} stroke="#e2e8f0" strokeWidth="1" />
        ))}

        {/* Y-axis labels */}
        {yLabels.map((t, i) => (
          <text key={`yl-${i}`} x={leftPad - 10} y={t.y + 5} textAnchor="end" fill="#64748b" fontSize="20" fontWeight="600" fontFamily="system-ui, sans-serif">
            {t.label}
          </text>
        ))}

        {/* selected range highlight */}
        {selStart != null && selEnd != null ? (
          <rect x={mapX(selStart)} y={topPad} width={Math.max(2, mapX(selEnd) - mapX(selStart))} height={drawHeight} fill={colorFill} />
        ) : null}

        {/* goal line */}
        {mergedSpec.showGoalLine && Number.isFinite(Number(mergedSpec.goalLineValue)) ? (
          <line
            x1={leftPad} x2={leftPad + drawWidth}
            y1={mapY(Number(mergedSpec.goalLineValue))} y2={mapY(Number(mergedSpec.goalLineValue))}
            stroke="#94a3b8" strokeWidth="2" strokeDasharray="8 5"
          />
        ) : null}

        {/* bars or line/area */}
        {mergedSpec.type === "bar" ? (
          bars.map((b) => (
            <rect
              key={`bar-${b.i}`} x={b.x - b.w / 2} y={b.y} width={b.w} height={Math.max(1, b.h)}
              rx="6" fill={hoveredIndex === b.i ? colorStroke : colorBar} opacity={hoveredIndex === b.i ? 1 : 0.85}
              style={{ cursor: "pointer", transition: "opacity 0.15s" }}
              onClick={() => onTap(b.i, b.p)}
              onMouseEnter={() => setHoveredIndex(b.i)}
              onMouseLeave={() => setHoveredIndex(null)}
            />
          ))
        ) : (
          <>
            {mergedSpec.type === "area" ? <path d={areaPath} fill={colorFill} /> : null}
            <path d={linePath} fill="none" stroke={colorStroke} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
            {points.map((p, i) => (
              <circle
                key={`dot-${i}`} cx={mapX(i)} cy={mapY(Number(p.value))} r={hoveredIndex === i ? dotR + 3 : dotR}
                fill="#fff" stroke={colorStroke} strokeWidth="3"
                style={{ cursor: "pointer", transition: "r 0.15s" }}
                onClick={() => onTap(i, p)}
                onMouseEnter={() => setHoveredIndex(i)}
                onMouseLeave={() => setHoveredIndex(null)}
              />
            ))}
          </>
        )}

        {/* value tooltip on hover */}
        {hoveredIndex != null && points[hoveredIndex] ? (
          <g>
            <rect
              x={mapX(hoveredIndex) - 42} y={mapY(Number(points[hoveredIndex].value)) - 40}
              width="84" height="30" rx="8"
              fill="#1e293b"
            />
            <text
              x={mapX(hoveredIndex)} y={mapY(Number(points[hoveredIndex].value)) - 20}
              textAnchor="middle" fill="#fff" fontSize="18" fontWeight="700" fontFamily="system-ui, sans-serif"
            >
              {Number(points[hoveredIndex].value).toLocaleString()} {unit}
            </text>
          </g>
        ) : null}

        {/* anomaly rings */}
        {Array.isArray(mergedSpec.anomalies)
          ? mergedSpec.anomalies.map((a, idx) => {
              const pi = points.findIndex((p) => p.date === a.date || p.label === a.label);
              if (pi < 0) return null;
              return (
                <circle
                  key={`ano-${idx}`} cx={mapX(pi)} cy={mapY(Number(points[pi].value))} r="12"
                  fill="none" stroke="#dc2626" strokeWidth="3" style={{ cursor: "pointer" }}
                  onClick={() => onAnomalySelect?.({ ...a, point: points[pi], index: pi })}
                />
              );
            })
          : null}

        {/* X-axis labels */}
        {points.map((p, i) => (
          <text
            key={`xl-${i}`} x={mapX(i)} y={topPad + drawHeight + 36}
            textAnchor="middle" fill="#475569" fontSize="18" fontWeight="600" fontFamily="system-ui, sans-serif"
          >
            {p.label || i + 1}
          </text>
        ))}
      </svg>

      {unit ? <p style={{ textAlign: "right", color: "#64748b", fontSize: 16, margin: "4px 12px 0", fontWeight: 600 }}>Unit: {unit}</p> : null}
    </div>
  );
};

export default SmartTrendChart;
