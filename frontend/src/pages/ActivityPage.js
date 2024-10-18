import React, { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import PageLayout from "../components/PageLayout";
import { Chart } from "react-google-charts";
import "../css/activityPage.css";

function ActivityPage() {
  // get username from url
  const { username } = useParams();
  const { date } = useParams();


  const items = [
    { "Calories Burned": 793 },
    { "Activity Calories": 0 },
    { "Basal Metabolic Rate (BMR)": 792 },
    { "Active Score": -1 },
    { "Steps Taken": 0 },
    { "Floors Climbed": 0 },
    { "Elevation Gain": 0 },
    { "Sedentary Minutes": 614 },
    { "Lightly Active Minutes": 0 },
    { "Fairly Active Minutes": 0 },
    { "Very Active Minutes": 0 },
    { "Total Distance": 0 },
    { "Tracker Distance": 0 },
    { "Sedentary Distance": 0 },
    { "Lightly Active Distance": 0 },
    { "Moderately Active Distance": 0 },
    { "Very Active Distance": 0 },
    { "Logged Activities Distance": 0 },
    { "Marginal Calories": 0 },
    { "Calories Goal": 2588 },
    { "Steps Goal": 10000 },
    { "Distance Goal": 8.05 },
    { "Floors Goal": 10 },
    { "Active Minutes Goal": 30 },
  ];

  const chartsData = [
    {
      title: "Calories Burned vs Goal",
      type: "BarChart",
      data: [
        ["Metric", "Value"],
        ["Calories Burned", 793],
        ["Calories Goal", 2588],
      ],
    },
    {
      title: "Steps Taken vs Goal",
      type: "BarChart",
      data: [
        ["Metric", "Value"],
        ["Steps Taken", 0],
        ["Steps Goal", 10000],
      ],
    },
    {
      title: "Active Minutes",
      type: "PieChart",
      data: [
        ["Activity Type", "Minutes"],
        ["Sedentary Minutes", 614],
        ["Lightly Active Minutes", 30],
        ["Fairly Active Minutes", 20],
        ["Very Active Minutes", 100],
      ],
    },
  ];

  const summary =
    "Based on your activity summary, it looks like you’ve had minimal physical activity throughout the day.\nYou burned 793 calories, but with no activity calories recorded, it suggests that you’ve been mostly sedentary.\nYou didn’t take any steps, climb any floors, or cover any distance, and you spent 614 minutes being sedentary.\nAdditionally, there’s no record of light, moderate, or intense physical activity.\nTo improve your overall health, consider gradually increasing your daily physical activity. Start with small goals, like taking short walks to help you work towards your 10,000-step goal or using the stairs to meet your 10-floor goal.\nTry to incorporate at least 30 minutes of moderate exercise each day. Simple activities like stretching or standing up every hour can help reduce sedentary time. Paying attention to your heart rate and tracking your progress over time can also help you stay motivated and improve your active score.";

  return (
    <PageLayout>
      <div className="header">
        <div className="title">ACTIVITY - {date}</div>
        <div className="welcome">Welcome, {username}!</div>
      </div>
      <div className="body">
        <div className="col-area">
          <div className="single-value-scrollable-content">
            {items.map((item, index) => (
              <div key={index} className="single-value-scrollable-item">
                {/* 遍历对象中的 key 和 value */}
                {Object.entries(item).map(([key, value]) => (
                  <p key={key}>
                    {key}: {value}
                  </p>
                ))}
              </div>
            ))}
          </div>
        </div>
        <div className="row-area">
          <div className="chart-area">
            <div className="chart-scrollable-content">
            {chartsData.map((chart, index) => (
              <div className="chart-item" key={index}>
                <div className="chart-title">{chart.title}</div>
                <Chart
                  chartType={chart.type}
                  width="100%"
                  height="400px"
                  data={chart.data}
                  options={{
                    title: chart.title,
                    backgroundColor: "transparent",
                    is3D: true
                  }}
                />
              </div>
            ))}
            </div>
          </div>
          <div className="summary-area">
            <p className="summary-content">{summary}</p>
          </div>
        </div>
      </div>
    </PageLayout>
  );
}

export default ActivityPage;
