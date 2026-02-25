import React from "react";

const points = [45, 62, 58, 66, 54, 73, 69];

const WeeklyActivityCard = () => {
  const width = 540;
  const height = 180;
  const xStep = width / (points.length - 1);
  const path = points
    .map((point, index) => {
      const x = xStep * index;
      const y = height - (point / 100) * height;
      return `${index === 0 ? "M" : "L"} ${x} ${y}`;
    })
    .join(" ");

  return (
    <section className="ss-card ss-weekly-card" aria-label="Weekly activity trend">
      <h2>Weekly Activity</h2>
      <svg
        viewBox={`0 0 ${width} ${height + 30}`}
        className="ss-line-chart"
        role="img"
        aria-label="Weekly activity line chart Monday through Sunday"
      >
        <path d={path} className="ss-line-path" />
        {points.map((point, index) => {
          const x = xStep * index;
          const y = height - (point / 100) * height;
          return <circle key={`${point}-${index}`} cx={x} cy={y} r="4" className="ss-line-dot" />;
        })}
        {["M", "T", "W", "Th", "F", "S", "S"].map((label, index) => (
          <text key={label + index} x={xStep * index} y={height + 24} className="ss-axis-label" textAnchor="middle">
            {label}
          </text>
        ))}
      </svg>
    </section>
  );
};

export default WeeklyActivityCard;

