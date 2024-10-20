import React, { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import PageLayoutClean from "../components/PageLayoutClean";
import "../css/activitySingleDayPage.css";
import { Col, Row, Typography, Divider, Card, List, Space } from "antd";
import {
  FireOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  ClockCircleOutlined,
  ThunderboltOutlined,
  SmileOutlined,
  FrownOutlined,
} from "@ant-design/icons";
import { Pie, Tiny, Column } from "@ant-design/plots";

const { Title, Text } = Typography;

function ActivityPage() {
  // Get username from the URL
  const { username } = useParams();
  const { date } = useParams();

  const overallActivityEvaluation = 
  "Today, you burned a total of 1656 calories, including 373 calories from activities. While you completed several workouts and runs, your overall activity level was low, as you spent 1340 minutes sedentary. You logged 5351 steps, which is just over half of your step goal. Your run sessions were the most effective in terms of calorie burn, but activities like biking and interval workouts recorded minimal progress. To meet your goals, consider incorporating more active minutes, focusing on high-calorie-burning activities, and reducing sedentary time.";


  const activityData = [
    {
      name: "Interval Workout",
      detail: [
        {
          title: "Calorie - 10",
          icon: <FireOutlined style={{ color: "red" }} />,
        },
        {
          title: "Steps - 0",
          icon: <CheckCircleOutlined style={{ color: "green" }} />,
        },
        {
          title: "Duration - 10 minutes 37 seconds",
          icon: <ClockCircleOutlined />,
        },
        {
          title: "Start Time - 14:56",
          icon: <ClockCircleOutlined />,
        },
        {
          title: "Evaluation - Bad",
          description:
            "Your Interval Workout was low in intensity with minimal calorie burn and no recorded steps. Consider increasing the intensity or duration next time for better results.",
          icon: <FrownOutlined style={{ color: "red" }} />,
        },
      ],
    },
    {
      name: "Workout",
      detail: [
        {
          title: "Calorie - 27",
          icon: <FireOutlined style={{ color: "red" }} />,
        },
        {
          title: "Steps - 12",
          icon: <CheckCircleOutlined style={{ color: "green" }} />,
        },
        {
          title: "Duration - 21 minutes 10 seconds",
          icon: <ClockCircleOutlined />,
        },
        {
          title: "Start Time - 15:07",
          icon: <ClockCircleOutlined />,
        },
        {
          title: "Evaluation - Average",
          description:
            "Your workout was moderate in intensity. Increasing either the duration or intensity could help you achieve better results.",
          icon: <ThunderboltOutlined style={{ color: "orange" }} />,
        },
      ],
    },
    {
      name: "Bike",
      detail: [
        {
          title: "Calorie - 0",
          icon: <FireOutlined style={{ color: "red" }} />,
        },
        {
          title: "Steps - 0",
          icon: <CloseCircleOutlined style={{ color: "red" }} />,
        },
        {
          title: "Duration - 6 seconds",
          icon: <ClockCircleOutlined />,
        },
        {
          title: "Start Time - 15:28",
          icon: <ClockCircleOutlined />,
        },
        {
          title: "Evaluation - Poor",
          description:
            "The bike session recorded minimal activity. For better results, aim for a longer, more intense ride next time.",
          icon: <FrownOutlined style={{ color: "red" }} />,
        },
      ],
    },
    {
      name: "Workout",
      detail: [
        {
          title: "Calorie - 49",
          icon: <FireOutlined style={{ color: "red" }} />,
        },
        {
          title: "Steps - 15",
          icon: <CheckCircleOutlined style={{ color: "green" }} />,
        },
        {
          title: "Duration - 38 minutes 7 seconds",
          icon: <ClockCircleOutlined />,
        },
        {
          title: "Start Time - 15:28",
          icon: <ClockCircleOutlined />,
        },
        {
          title: "Evaluation - Good",
          description:
            "Great workout! You burned a good amount of calories and had consistent movement.",
          icon: <SmileOutlined style={{ color: "green" }} />,
        },
      ],
    },
  ];

  const singleValueData = [
    {
      key: "Basal Metabolic Rate Calories",
      value: 1288,
      description:
        "Your basal metabolic rate is within a typical range. Keep a balanced diet to support this rate.",
    },
    {
      key: "Today's Steps",
      value: 5351,
      description:
        "You've made some progress today, but you're still far from reaching your step goal.",
    },
    {
      key: "Elevation Gained (Meters)",
      value: 9.144,
      description:
        "You have gained a small elevation today. Try increasing activity for more elevation gain.",
    },
    {
      key: "Resting Heart Rate",
      value: 82,
      description:
        "Your resting heart rate is slightly elevated. Consider relaxing and monitoring your heart rate.",
    },
  ];

  const activityTimeData = [
    {
      type: "Sedentary Minutes",
      value: 1340,
    },
    {
      type: "Lightly Active Minutes",
      value: 50,
    },
    {
      type: "Fairly Active Minutes",
      value: 42,
    },
    {
      type: "Very Active Minutes",
      value: 8,
    },
  ];

  const activityTimeEvaluation =
    "You have been sedentary for most of the day with minimal active minutes. Consider increasing your activity levels to improve your overall health.";

  const pieConfig = {
    data: activityTimeData,
    radius: 1,
    angleField: "value",
    colorField: "type",
    label: {
      text: "value",
      position: "outside",
      style: {
        fontSize: 13, // Increase font size
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
    width: 350, // Set chart width
    height: 350, // Set chart height
  };

  const goalPercentage = [
    {
      name: "Steps",
      goal: 10000,
      current: 6351,
      description:
        "You are making good progress, but there's room to reach your step goal.",
    },
    {
      name: "Floors",
      goal: 10,
      current: 2,
      description:
        "You have climbed some floors today, but more effort is needed to reach your goal.",
    },
    {
      name: "Distance (km)",
      goal: 8.05,
      current: 2.7632,
      description:
        "You have covered some distance today, but you are far from the target.",
    },
    {
      name: "Calories Burned",
      goal: 2588,
      current: 1656,
      description:
        "Good job! You're over halfway to your calorie-burning goal.",
    },
    {
      name: "Active Minutes",
      goal: 30,
      current: 100,
      description:
        "Amazing! You have surpassed your active minutes goal for the day.",
    },
  ];

  const goalPercentageConfigs = [];

  for (let i = 0; i < goalPercentage.length; i++) {
    let percent = goalPercentage[i].current / goalPercentage[i].goal;
    let color = "#FF4D4F"; // Default to red

    if (percent >= 1) {
      percent = 1; // Set to 1 if greater than or equal to 100%
      color = "#52C41A"; // Green
    } else if (percent >= 0.5) {
      color = "#FAAD14"; // Yellow
    }

    percent = percent.toFixed(1); // Round to one decimal place

    goalPercentageConfigs.push({
      percent,
      width: 120,
      height: 120,
      color: ["#E8EFF5", color],
      annotations: [
        {
          type: "text",
          style: {
            text: `${(percent * 100).toFixed(0)}%`, // Display as integer percentage
            x: "50%",
            y: "50%",
            textAlign: "center",
            fontSize: 16,
            fontStyle: "bold",
          },
        },
      ],
    });
  }

  const activityCalories = [
    {
      name: "Interval Workout",
      calories: 10,
    },
    {
      name: "Workout (Session 1)",
      calories: 27,
    },
    {
      name: "Bike",
      calories: 70,
    },
    {
      name: "Workout (Session 2)",
      calories: 49,
    },
    {
      name: "Run (Session 1)",
      calories: 137,
    },
    {
      name: "Run (Session 2)",
      calories: 114,
    },
  ];

  const activityCaloriesConfig = {
    data: activityCalories,
    xField: "name",
    yField: "calories",
    label: {
      text: (d) => `${d.calories}`,
      textBaseline: "bottom",
    },
    style: {
      // Rounded corner style
      radiusTopLeft: 10,
      radiusTopRight: 10,
    },
    width: 350,
    height: 350,
  };

  const activityCaloriesEvaluation =
    "Today, you burned a total of 337 calories across various activities, including interval workouts, running, and workouts. Your highest calorie-burning activity was running, contributing significantly to your overall calorie expenditure. However, there were some activities like biking that recorded minimal or no calorie burn. ";

  return (
    <PageLayoutClean>
      <Row justify="space-around" align="middle">
        <Col span={5}>
          <Title>Activity - {date}</Title>
        </Col>
        <Col span={5}>
          <Title>Welcome, {username}!</Title>
        </Col>
      </Row>
      <Row justify="space-around">
        <Col span={20}><Text strong>{overallActivityEvaluation}</Text></Col>
      </Row>
      <Divider
        variant="dashed"
        style={{
          borderColor: "#2E4265",
        }}
      />
      <Row justify="space-around">
        <Col span={7}>
          <Row gutter={[10, 10]}>
            {activityData.map((activity) => (
              <Col span={12} key={activity.name}>
                <Card title={activity.name} bordered={false} size="small">
                  <List
                    itemLayout="horizontal"
                    dataSource={activity.detail}
                    renderItem={(item) => (
                      <List.Item>
                        <List.Item.Meta
                          avatar={item.icon}
                          title={<Text strong>{item.title}</Text>}
                          description={item.description || ""}
                        />
                      </List.Item>
                    )}
                  />
                </Card>
              </Col>
            ))}
          </Row>
        </Col>
        <Col span={15}>
          <Row gutter={[10, 10]}>
            {singleValueData.map((item, index) => (
              <Col span={5} key={index}>
                <Card title={item.key} bordered={false} size="small">
                  Value: {item.value}
                  <br />
                  Note: {item.description}
                </Card>
              </Col>
            ))}
            {goalPercentage.map((item, index) => (
              <Col span={5} key={index}>
                <Card title={item.name} bordered={false} size="small">
                  Goal: {item.goal}; Current: {item.current}
                  <Tiny.Ring {...goalPercentageConfigs[index]} />
                  Note: {item.description}
                </Card>
              </Col>
            ))}
            <Col span={8}>
              <Card size="small">
                <Pie {...pieConfig} />
                <Text strong>{activityTimeEvaluation}</Text>
              </Card>
            </Col>
            <Col span={8}>
              <Card size="small">
                <Column {...activityCaloriesConfig} />
                <Text strong>{activityCaloriesEvaluation}</Text>
              </Card>
            </Col>
          </Row>
        </Col>
      </Row>
    </PageLayoutClean>
  );
}

export default ActivityPage;
