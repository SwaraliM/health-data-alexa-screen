import React from "react";
import { Card, List, Typography } from "antd";
import { RightCircleTwoTone } from "@ant-design/icons";
import "../css/customList.css";

const { Text } = Typography;

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

const formatListItem = (item) => {
  if (typeof item === "string") return { primary: item, secondary: null };
  if (!item || typeof item !== "object") return { primary: String(item ?? ""), secondary: null };

  const label = item.label || item.name || item.title || item.key || null;
  const value = item.value ?? item.result ?? null;
  const insight = item.insight || item.description || item.action || null;
  const category = item.category || null;

  if (label && value !== null && value !== undefined) {
    return { primary: `${label}: ${value}`, secondary: insight, tag: category };
  }
  if (label) {
    return { primary: label, secondary: insight || value, tag: category };
  }
  const textKeys = Object.values(item).filter((v) => typeof v === "string" && v.length > 0);
  return { primary: textKeys[0] || JSON.stringify(item), secondary: textKeys[1] || null, tag: null };
};

const CustomList = ({ componentData, height, width, data, options }) => {
  let finalProps = {};

  if (componentData) {
    finalProps = {
      height: height || extractValue(componentData, ['data.height', 'height']),
      width: width || extractValue(componentData, ['data.width', 'width']),
      title: extractValue(componentData, ['data.title', 'title']) || "List",
      options: options || extractValue(componentData, ['data.options', 'options']),
    };
    finalProps.list = extractValue(componentData, ['data.list', 'data.items', 'data.data', 'list', 'items', 'data']) || [];
  } else {
    finalProps = { height, width, title: data?.title || "List", options };
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
        <List itemLayout="vertical">
          {listArray.map((raw, index) => {
            const { primary, secondary, tag } = formatListItem(raw);
            return (
              <List.Item key={index} style={{ padding: "10px 0", borderBottom: "1px solid #f0f0f0" }}>
                <div style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
                  <RightCircleTwoTone style={{ fontSize: "20px", marginTop: "3px", flexShrink: 0 }} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: "18px", fontWeight: "600", lineHeight: 1.35, wordWrap: "break-word" }}>{primary}</div>
                    {secondary && (
                      <Text type="secondary" style={{ fontSize: "15px", lineHeight: 1.4, display: "block", marginTop: "4px", wordWrap: "break-word" }}>
                        {secondary}
                      </Text>
                    )}
                    {tag && (
                      <span style={{
                        display: "inline-block", marginTop: "6px", padding: "2px 10px",
                        borderRadius: "999px", fontSize: "13px", fontWeight: 600,
                        background: "#e9efff", color: "#1d4eb5",
                      }}>
                        {tag}
                      </span>
                    )}
                  </div>
                </div>
              </List.Item>
            );
          })}
        </List>
      </Card>
    </div>
  );
};

export default CustomList;
