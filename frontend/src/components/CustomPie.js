import React from "react";
import { Card } from "antd";
import { Pie } from "@ant-design/plots";
import "../css/customPie.css";

const CustomPie = ({ height, width, title, data, options }) => {
  const pieHeight = parseInt(height, 10);
  const pieWidth = parseInt(width, 10);
  const config = {
    height: pieHeight,
    width: pieWidth,
    data,
    angleField: "value",
    colorField: "type",
    label: {
      text: "value",
      style: {
        fontWeight: "bold",
      },
    },
    legend: {
      color: {
        title: false,
        position: "right",
        rowPadding: 5,
      },
    },
  };

  return (
    <Card
    className="pie-card"
      title={title}
      size="small"
      style={{ height: height, width: width, ...options }}
    >
      <Pie {...config} />
    </Card>
  );
};

export default CustomPie;
