import React from "react";
import { Card } from "antd";
import { Line } from "@ant-design/plots";
import "../css/customLineChart.css";

const CustomLineChart = ({ height, width, title, data, options }) => {
  const chartHeight = parseInt(height, 10) * 0.8;
  const chartWidth = parseInt(width, 10) * 0.8;
  const config = {
    height: chartHeight,
    width: chartWidth,
    data,
    xField: Object.keys(data[0])[0],
    yField: Object.keys(data[0])[1],
    point: {
      shapeField: "square",
      sizeField: 4,
    },
    interaction: {
      tooltip: {
        marker: false,
      },
    },
    style: {
      lineWidth: 2,
    },
  };

  return (
    <Card
      className="line-card"
      title={title}
      size="small"
      style={{ height: height, width: width, ...options }}
    >
      <Line {...config} />
    </Card>
  );
};

export default CustomLineChart;
