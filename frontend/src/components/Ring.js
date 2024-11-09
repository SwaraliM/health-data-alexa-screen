import React from "react";
import { Card } from "antd";
import { Tiny } from "@ant-design/plots";
import "../css/ring.css";

const Ring = ({ height, width, title, goal, current, options }) => {
  let percent = (current / goal);
  let color = "#FF4D4F"; // Default to red

  if (percent >= 1) {
    percent = 1; // Set to 1 if greater than or equal to 100%
    color = "#52C41A"; // Green
  } else if (percent >= 0.8) {
    color = "#52C41A"; // Green
  } else if (percent >= 0.4) {
    color = "#FAAD14"; // Yellow
  }
  const ringWidth = parseInt(width, 10) * 0.4;

  const config = {
    percent: Math.max(percent, 0.0001),
    width: ringWidth,
    height: ringWidth,
    color: ["#EBF2FF", color],
    annotations: [
      {
        type: "text",
        style: {
          text: `${(percent * 100).toFixed(1)}%`,
          x: "50%",
          y: "50%",
          textAlign: "center",
          fontSize: 20,
          fontStyle: "bold",
        },
      },
    ],
  };
  return (
    <div className="ring">
      <Card
        title={<h2>{title}</h2>}
        bordered={false}
        size="small"
        style={{ height: height, width: width, ...options }}
        className="ring-card"
      >
        <div className="ring-goal">
          Goal: {goal}
        </div>
        <div className="ring-current">Current: {current}</div>
        <Tiny.Ring {...config} />
      </Card>
    </div>
  );
};

export default Ring;
