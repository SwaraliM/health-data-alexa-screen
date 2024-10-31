import React, { useState, useEffect } from "react";
import "../css/todayActivityPage.css";
import { useParams } from "react-router-dom";
import PageLayoutClean from "../components/PageLayoutClean";
import { Col, Row, Typography, Card, List, Statistic } from "antd";
import CountUp from "react-countup";
import {
  FireOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  ClockCircleOutlined,
  ThunderboltOutlined,
  FlagOutlined,
  SmileOutlined,
  FrownOutlined,
} from "@ant-design/icons";
import CustomList from "../components/CustomList";
import SingleValue from "../components/SingleValue";
import Ring from "../components/Ring";

import { getCurrentDate } from "../utils/getCurrentDate";
import convertTime from "../utils/convertTime";

const { Text } = Typography;

const formatter = (value) => <CountUp end={value} separator="," />;

const TodayActivityPage = () => {
  const { username, random } = useParams();

  const [data, setData] = useState(null);
  const [activitiesList, setActivitiesList] = useState([]);

  const fetchData = async () => {
    try {
      const date = getCurrentDate();
      console.log(
        `${process.env.REACT_APP_FETCH_DATA_URL}/api/fitbit/${username}/activities/summary/${date}`
      );
      const response = await fetch(
        `${process.env.REACT_APP_FETCH_DATA_URL}/api/fitbit//${username}/activities/summary/${date}`
      );
      if (!response.ok) {
        throw new Error("Network response was not ok");
      }
      const result = await response.json();
      console.log("Setting data:", result);
      setData(result);
    } catch (error) {
      throw new Error("error");
    }
  };

  useEffect(() => {
    // Fetch data once when the component loads
    fetchData();

    // Set up an interval to fetch data every 5 minutes (300000 milliseconds)
    const intervalId = setInterval(fetchData, 300000);

    // Clear the interval when the component unmounts
    return () => clearInterval(intervalId);
  }, []); // Empty dependency array ensures it runs only on initial load

  useEffect(() => {
    if (data) {
      const newActivitiesList = data.activities.map((activity) => ({
        title: activity.name,
        list: [
          `Calorie - ${activity.calories}`,
          `Steps - ${activity.steps}`,
          `Duration - ${convertTime(activity.duration)}`,
          `Start Time - ${activity.startTime}`,
        ],
      }));
      setActivitiesList(newActivitiesList);
    }
  }, [data]);

  return (
    <PageLayoutClean>
      <div className="a-header">
        <h1>Today Activity Overview Dashboard</h1>
        <h1>Welcome, {username}!</h1>
      </div>
      {data ? (
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
                value={data.summary.caloriesOut}
              />
              <SingleValue
                height="120px"
                width="150px"
                title="Steps"
                value={data.summary.steps}
              />
              <SingleValue
                height="120px"
                width="150px"
                title="Floors"
                value={data.summary.floors}
              />
              <SingleValue
                height="120px"
                width="150px"
                title="Basal Metabolic Rate"
                value={data.summary.caloriesBMR}
              />
              <SingleValue
                height="120px"
                width="150px"
                title="Distance"
                value={
                  data.summary.distances.find(
                    (item) => item.activity === "total"
                  ).distance
                }
              />
              <SingleValue
                height="120px"
                width="150px"
                title="Active Time"
                value={
                  data.summary.lightlyActiveMinutes +
                  data.summary.fairlyActiveMinutes +
                  data.summary.veryActiveMinutes
                }
              />
            </div>
            <div className="a-ring-area">
              <Ring
                height="190px"
                width="180px"
                title="Calories Burned"
                current={data.summary.caloriesOut}
                goal={data.goals.caloriesOut}
              />
              <Ring
                height="190px"
                width="180px"
                title="Steps"
                current={data.summary.steps}
                goal={data.goals.steps}
              />
              <Ring
                height="190px"
                width="180px"
                title="Floors"
                current={data.summary.floors}
                goal={data.goals.floors}
              />
              <Ring
                height="190px"
                width="180px"
                title="Distance"
                current={data.summary.distances.find(
                    (item) => item.activity === "total"
                  ).distance}
                goal={data.goals.distance}
              />
              <Ring
                height="190px"
                width="180px"
                title="Active Minutes"
                current={ data.summary.lightlyActiveMinutes +
                    data.summary.fairlyActiveMinutes +
                    data.summary.veryActiveMinutes}
                goal={data.goals.activeMinutes}
              />
            </div>

            <div className="a-chart-area"></div>
          </div>
        </div>
      ) : (
        <div>loading...</div>
      )}
    </PageLayoutClean>
  );
};

export default TodayActivityPage;
