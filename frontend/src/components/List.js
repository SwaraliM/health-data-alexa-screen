import React from "react";
import { Card, List, Typography } from "antd";
import "../css/list.css";

const { Text } = Typography;

const CustomList = ({ height, width, data }) => {
  return (
    <Card
      className="list-card"
      title={data.title}
      bordered={false}
      size="small"
      style={{ height: height, width: width }}
    >
      <List itemLayout="horizontal">
        {data.list.map((item, index) => (
          <List.Item key={index} style={{ padding: "2px 0" }}>
            <List.Item.Meta
              avatar={item.icon}
              title={<Text strong>{item.text}</Text>}
            />
          </List.Item>
        ))}
      </List>
    </Card>
  );
};

export default CustomList;
