import React, { useState, useEffect } from "react";
import "../css/todayActivityPage.css";
import { useParams } from "react-router-dom";
import PageLayoutClean from "../components/PageLayoutClean";
import CustomList from "../components/CustomList";
import SingleValue from "../components/SingleValue";
import Ring from "../components/Ring";
import CustomPie from "../components/CustomPie";
import CustomLineChart from "../components/CustomLineChart";

import { getCurrentDate } from "../utils/getCurrentDate";
import { getCurrentTime } from "../utils/getCurrentTime";
import convertTime from "../utils/convertTime";

const TodayActivityPage = () => {
  const { username, random } = useParams();

  const [todayData, setTodayData] = useState(null);
  const [weeklyStepData, setWeeklyStepData] = useState(null);
  const [activitiesList, setActivitiesList] = useState([]);
  const [pieList, setPieList] = useState([]);
  const [currentTime, setCurrentTime] = useState(getCurrentTime());

  const fetchTodayData = async () => {
    try {
      const date = getCurrentDate();
      const response = await fetch(
        `${process.env.REACT_APP_FETCH_DATA_URL}/api/fitbit/${username}/activities/summary/${date}`
      );
      if (!response.ok) {
        throw new Error("Network response was not ok");
      }
      const result = await response.json();
      console.log(JSON.stringify(result, 2, null));
      setTodayData(result);
    } catch (error) {
      throw new Error("error");
    }
  };

  const fetchWeeklyStepData = async () => {
    try {
      const date = getCurrentDate();
      const response = await fetch(
        `${process.env.REACT_APP_FETCH_DATA_URL}/api/fitbit//${username}/activities/period/steps/date/${date}/7d`
      );
      if (!response.ok) {
        throw new Error("Network response was not ok");
      }
      const result = await response.json();
      setWeeklyStepData(result);
    } catch (error) {
      throw new Error("error");
    }
  };

  useEffect(() => {
    // Fetch both today's data and weekly data when the component loads
    fetchTodayData();
    fetchWeeklyStepData();

    // Set up an interval to fetch today's data every 5 minutes
    const todayIntervalId = setInterval(fetchTodayData, 300000);

    // Set up an interval to fetch weekly data every 5 minutes
    const weeklyIntervalId = setInterval(fetchWeeklyStepData, 300000);

    // Clear intervals when the component unmounts
    return () => {
      clearInterval(todayIntervalId);
      clearInterval(weeklyIntervalId);
    };
  }, []); // Empty dependency array ensures it runs only on initial load

  useEffect(() => {
    if (todayData) {
      const newActivitiesList = todayData.activities.map((activity) => ({
        title: activity.name,
        list: [
          `Calorie - ${activity.calories}`,
          `Steps - ${activity.steps}`,
          `Duration - ${convertTime(activity.duration)}`,
          `Start Time - ${activity.startTime}`,
        ],
      }));
      const newPieList = [
        {
          type: "Sedentary Minutes",
          value: todayData.summary.sedentaryMinutes,
        },
        {
          type: "Lightly Active Minutes",
          value: todayData.summary.lightlyActiveMinutes,
        },
        {
          type: "Fairly Active Minutes",
          value: todayData.summary.fairlyActiveMinutes,
        },
        {
          type: "Very Active Minutes",
          value: todayData.summary.veryActiveMinutes,
        },
      ];
      setActivitiesList(newActivitiesList);
      setPieList(newPieList);
      console.log(newPieList);
    }
  }, [todayData]);

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(getCurrentTime());
    }, 60000);
    return () => clearInterval(interval);
  }, []);

  return (
    <PageLayoutClean>
      <div className="a-header">
      <h3>{getCurrentDate()} {currentTime}</h3>
        <h1>Today Activity Overview Dashboard</h1>
        <h1>Welcome, {username}!</h1>
      </div>
      {todayData ? (
        <div className="a-body">
          <div className="a-activities-area">
            <div className="a-activities">
              <h2>Activity</h2>
              {activitiesList.map((activity, index) => (
                <CustomList
                  options={{ marginBottom: "10px" }}
                  height="fit-content"
                  width="400px"
                  data={activity}
                />
              ))}
            </div>
          </div>
          <div className="a-other-area">
            <div className="a-single-value-area">
              <SingleValue
                height="120px"
                width="150px"
                title="Calories Burned"
                value={todayData.summary.caloriesOut}
              />
              <SingleValue
                height="120px"
                width="150px"
                title="Steps"
                value={todayData.summary.steps}
              />
              <SingleValue
                height="120px"
                width="150px"
                title="Floors"
                value={todayData.summary.floors}
              />
              <SingleValue
                height="120px"
                width="150px"
                title="Basal Metabolic Rate"
                value={todayData.summary.caloriesBMR}
              />
              <SingleValue
                height="120px"
                width="150px"
                title="Distance"
                value={
                  todayData.summary.distances.find(
                    (item) => item.activity === "total"
                  ).distance
                }
              />
              <SingleValue
                height="120px"
                width="150px"
                title="Active Time"
                value={
                  todayData.summary.lightlyActiveMinutes +
                  todayData.summary.fairlyActiveMinutes +
                  todayData.summary.veryActiveMinutes
                }
              />
            </div>
            <div className="a-ring-area">
              <Ring
                height="190px"
                width="180px"
                title="Calories Burned"
                current={todayData.summary.caloriesOut}
                goal={todayData.goals.caloriesOut}
              />
              <Ring
                height="190px"
                width="180px"
                title="Steps"
                current={todayData.summary.steps}
                goal={todayData.goals.steps}
              />
              <Ring
                height="190px"
                width="180px"
                title="Floors"
                current={todayData.summary.floors}
                goal={todayData.goals.floors}
              />
              <Ring
                height="190px"
                width="180px"
                title="Distance"
                current={
                  todayData.summary.distances.find(
                    (item) => item.activity === "total"
                  ).distance
                }
                goal={todayData.goals.distance}
              />
              <Ring
                height="190px"
                width="180px"
                title="Active Minutes"
                current={
                  todayData.summary.lightlyActiveMinutes +
                  todayData.summary.fairlyActiveMinutes +
                  todayData.summary.veryActiveMinutes
                }
                goal={todayData.goals.activeMinutes}
              />
            </div>

            <div className="a-chart-area">
              <CustomPie
                height={300}
                width={300}
                title="Daily Activity Breakdown"
                data={pieList}
              />
              {weeklyStepData && weeklyStepData["activities-steps"] && (
                <CustomLineChart
                  height={300}
                  width={600}
                  title="Weekly Steps"
                  data={weeklyStepData["activities-steps"].map((item) => ({
                    ...item,
                    value: parseInt(item.value, 10),
                  }))}
                />
              )}
            </div>
          </div>
        </div>
      ) : (
        <div>loading...</div>
      )}
    </PageLayoutClean>
  );
};

export default TodayActivityPage;
