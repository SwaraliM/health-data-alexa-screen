import React from "react";
import { Card, List, Typography } from "antd";
import { RightCircleTwoTone } from "@ant-design/icons";
import "../css/customList.css";

const CustomList = ({ height, width, data, options }) => {
  return (
    <div className="custom-list">
      <Card
        title={<h2>{data.title}</h2>}
        bordered={false}
        size="small"
        style={{ height: height, width: width, ...options }}
      >
        <List itemLayout="horizontal">
          {data.list.map((item, index) => (
            <List.Item key={index} style={{ padding: "2px 0" }}>
              <List.Item.Meta
                avatar={<RightCircleTwoTone />}
                title={<div style={{ fontSize: '20px' }}>{item}</div>}
              />
            </List.Item>
          ))}
        </List>
      </Card>
    </div>
  );
};

export default CustomList;
