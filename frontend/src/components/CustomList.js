import React from "react";
import { Card, List, Typography } from "antd";
import { RightCircleTwoTone } from "@ant-design/icons";

const { Text } = Typography;

const CustomList = ({ height, width, data, options }) => {
  return (
    <Card
      title={data.title}
      bordered={false}
      size="small"
      style={{ height: height, width: width, ...options }}
    >
      <List itemLayout="horizontal">
        {data.list.map((item, index) => (
          <List.Item key={index} style={{ padding: "2px 0" }}>
            <List.Item.Meta
              avatar={<RightCircleTwoTone />}
              title={<Text strong>{item}</Text>}
            />
          </List.Item>
        ))}
      </List>
    </Card>
  );
};

export default CustomList;
