import React, { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import PageLayoutClean from "../components/PageLayoutClean";
import "../css/activitySingleDayPage.css";
import { Col, Row, Typography } from "antd";
import { blue } from '@ant-design/colors';

const { Title } = Typography;

function ActivityPage() {
  // get username from url
  const { username } = useParams();
  const { date } = useParams();

  const data = {
    activities: [
      {
        logId: 8773697742692057000,
        activityId: 20057,
        activityParentId: 20057,
        activityParentName: "Interval Workout",
        name: "Interval Workout",
        description: "",
        calories: 10,
        distance: 0,
        steps: 0,
        duration: 637000,
        lastModified: "2024-10-18T19:42:31.082Z",
        startTime: "14:56",
        isFavorite: false,
        hasActiveZoneMinutes: true,
        startDate: "2024-10-18",
        hasStartTime: true,
      },
      {
        logId: 1899191620171960000,
        activityId: 3000,
        activityParentId: 3000,
        activityParentName: "Workout",
        name: "Workout",
        description: "",
        calories: 27,
        steps: 12,
        duration: 1270000,
        lastModified: "2024-10-18T19:42:31.171Z",
        startTime: "15:07",
        isFavorite: false,
        hasActiveZoneMinutes: true,
        startDate: "2024-10-18",
        hasStartTime: true,
      },
      {
        logId: 6367939164943332000,
        activityId: 90001,
        activityParentId: 90001,
        activityParentName: "Bike",
        name: "Bike",
        description: "Mountain Biking/BMX",
        calories: 0,
        distance: 0,
        duration: 6000,
        lastModified: "2024-10-18T19:42:31.082Z",
        startTime: "15:28",
        isFavorite: false,
        hasActiveZoneMinutes: true,
        startDate: "2024-10-18",
        hasStartTime: true,
      },
      {
        logId: 5851601774111050000,
        activityId: 3000,
        activityParentId: 3000,
        activityParentName: "Workout",
        name: "Workout",
        description: "",
        calories: 49,
        steps: 15,
        duration: 2287000,
        lastModified: "2024-10-18T20:10:10.626Z",
        startTime: "15:28",
        isFavorite: false,
        hasActiveZoneMinutes: true,
        startDate: "2024-10-18",
        hasStartTime: true,
      },
      {
        logId: 116788054595334260,
        activityId: 90009,
        activityParentId: 90009,
        activityParentName: "Run",
        name: "Run",
        description: "Running - 5 mph (12 min/mile)",
        calories: 137,
        distance: 1.7372,
        steps: 2537,
        duration: 1910000,
        lastModified: "2024-10-18T21:44:46.834Z",
        startTime: "16:44",
        isFavorite: false,
        hasActiveZoneMinutes: true,
        startDate: "2024-10-18",
        hasStartTime: true,
      },
      {
        logId: 7577160948127935000,
        activityId: 90009,
        activityParentId: 90009,
        activityParentName: "Run",
        name: "Run",
        description: "Running - 5 mph (12 min/mile)",
        calories: 114,
        distance: 1.77164,
        steps: 2330,
        duration: 1602000,
        lastModified: "2024-10-18T22:30:23.485Z",
        startTime: "17:58",
        isFavorite: false,
        hasActiveZoneMinutes: true,
        startDate: "2024-10-18",
        hasStartTime: true,
      },
    ],
    summary: {
      caloriesOut: 1656,
      activityCalories: 373,
      caloriesBMR: 1288,
      activeScore: -1,
      steps: 5351,
      floors: 3,
      elevation: 9.144,
      sedentaryMinutes: 1340,
      lightlyActiveMinutes: 50,
      fairlyActiveMinutes: 42,
      veryActiveMinutes: 8,
      distances: [
        {
          activity: "total",
          distance: 3.7632,
        },
        {
          activity: "tracker",
          distance: 3.7632,
        },
        {
          activity: "sedentaryActive",
          distance: 0.0007,
        },
        {
          activity: "lightlyActive",
          distance: 0.5901,
        },
        {
          activity: "moderatelyActive",
          distance: 2.6458,
        },
        {
          activity: "veryActive",
          distance: 0.5266,
        },
        {
          activity: "loggedActivities",
          distance: 3.50884,
        },
        {
          activity: "Interval Workout",
          distance: 0,
        },
        {
          activity: "Bike",
          distance: 0,
        },
        {
          activity: "Run",
          distance: 1.7372,
        },
        {
          activity: "Run",
          distance: 1.77164,
        },
      ],
      marginalCalories: 285,
      restingHeartRate: 82,
      heartRateZones: [],
    },
    goals: {
      caloriesOut: 2588,
      steps: 10000,
      distance: 8.05,
      floors: 10,
      activeMinutes: 30,
    },
  };

  const summary =
    "Based on your activity summary, it looks like you’ve had minimal physical activity throughout the day.\nYou burned 793 calories, but with no activity calories recorded, it suggests that you’ve been mostly sedentary.\nYou didn’t take any steps, climb any floors, or cover any distance, and you spent 614 minutes being sedentary.\nAdditionally, there’s no record of light, moderate, or intense physical activity.\nTo improve your overall health, consider gradually increasing your daily physical activity. Start with small goals, like taking short walks to help you work towards your 10,000-step goal or using the stairs to meet your 10-floor goal.\nTry to incorporate at least 30 minutes of moderate exercise each day. Simple activities like stretching or standing up every hour can help reduce sedentary time. Paying attention to your heart rate and tracking your progress over time can also help you stay motivated and improve your active score.";

  return (
    <PageLayoutClean>
      <Row justify="space-around">
      <Title className="title">h1. Ant Design</Title>
      </Row>
    </PageLayoutClean>
  );
}

export default ActivityPage;
