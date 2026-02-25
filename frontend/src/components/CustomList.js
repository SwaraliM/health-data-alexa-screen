import React from "react";
import { Card, List, Typography } from "antd";
import { RightCircleTwoTone } from "@ant-design/icons";
import "../css/customList.css";

// Helper function to extract value from nested object
const extractValue = (obj, paths) => {
  for (const path of paths) {
    const keys = path.split('.');
    let value = obj;
    for (const key of keys) {
      if (value && typeof value === 'object' && key in value) {
        value = value[key];
      } else {
        value = null;
        break;
      }
    }
    if (value !== null && value !== undefined) return value;
  }
  return null;
};

const CustomList = ({ componentData, height, width, data, options }) => {
  console.log("List received componentData:", componentData);
  
  // Extract props from componentData if provided
  let finalProps = {};
  
  if (componentData) {
    finalProps = {
      height: height || extractValue(componentData, ['data.height', 'height']),
      width: width || extractValue(componentData, ['data.width', 'width']),
      title: extractValue(componentData, ['data.title', 'title']) || "List",
      options: options || extractValue(componentData, ['data.options', 'options']),
    };
    
    // Find list array wherever it might be
    finalProps.list = extractValue(componentData, ['data.list', 'data.items', 'data.data', 'list', 'items', 'data']) || [];
  } else {
    finalProps = { height, width, title: data?.title || "List", options };
    
    // Handle field name variations: list, items, data
    if (data?.list && Array.isArray(data.list)) {
      finalProps.list = data.list;
    } else if (data?.items && Array.isArray(data.items)) {
      finalProps.list = data.items;
    } else if (data?.data && Array.isArray(data.data)) {
      finalProps.list = data.data;
    } else if (Array.isArray(data)) {
      finalProps.list = data;
    } else {
      finalProps.list = [];
    }
  }
  
  const { height: finalHeight, width: finalWidth, title: finalTitle, list: listArray, options: finalOptions } = finalProps;
  
  if (!listArray || listArray.length === 0) {
    return (
      <div className="custom-list">
        <Card
          title={<h2 style={{ fontSize: "24px", fontWeight: "600", margin: 0 }}>{finalTitle}</h2>}
          bordered={false}
          size="small"
          style={{ height: finalHeight, width: finalWidth, ...finalOptions }}
        >
          <div style={{ padding: "20px", color: "#8c8c8c" }}>No items to display</div>
        </Card>
      </div>
    );
  }
  
  return (
    <div className="custom-list">
      <Card
        title={<h2 style={{ fontSize: "24px", fontWeight: "600", margin: 0 }}>{finalTitle}</h2>}
        bordered={false}
        size="small"
        style={{ height: finalHeight, width: finalWidth, ...finalOptions }}
      >
        <List itemLayout="horizontal">
          {listArray.map((item, index) => (
            <List.Item key={index} style={{ padding: "8px 0" }}>
              <List.Item.Meta
                avatar={<RightCircleTwoTone style={{ fontSize: "20px" }} />}
                title={<div style={{ fontSize: '18px', fontWeight: "500" }}>{typeof item === 'string' ? item : JSON.stringify(item)}</div>}
              />
            </List.Item>
          ))}
        </List>
      </Card>
    </div>
  );
};

export default CustomList;
