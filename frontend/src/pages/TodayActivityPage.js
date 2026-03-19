import React, { useState, useEffect } from "react";
import "../css/todayActivityPage.css";
import { useParams } from "react-router-dom";
import PageLayoutClean from "../components/PageLayoutClean";
import CustomList from "../components/CustomList";
import Ring from "../components/Ring";
import CustomLineChart from "../components/CustomLineChart";
import { getCurrentDate } from "../utils/getCurrentDate";
import { getCurrentTime } from "../utils/getCurrentTime";
import convertTime from "../utils/convertTime";

const TodayActivityPage = () => {
  const { username, random } = useParams();

  const [todayData, setTodayData] = useState(null);
  const [weeklyStepData, setWeeklyStepData] = useState(null);
  const [activitiesList, setActivitiesList] = useState([]);
  const [currentTime, setCurrentTime] = useState(getCurrentTime());
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchTodayData = async () => {
    try {
      setError(null);
      const date = getCurrentDate();
      // Use localhost for local development, ngrok URL only for production/external access
      // Check if we're running locally (development mode)
      const isLocalDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
      const baseUrl = isLocalDev ? 'http://localhost:5001' : (process.env.REACT_APP_FETCH_DATA_URL || 'http://localhost:5001');
      const url = `${baseUrl}/api/fitbit/${username}/activities/summary/${date}`;
      console.log("Fetching today's data from:", url);
      console.log("Using base URL:", baseUrl, "(isLocalDev:", isLocalDev, ")");
      
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'ngrok-skip-browser-warning': 'true', // Skip ngrok browser warning (if using ngrok)
        },
      });
      
      // First, get the response as text to check what we actually received
      const responseText = await response.text();
      
      // Check if we got HTML instead of JSON
      if (responseText.trim().startsWith('<!DOCTYPE') || responseText.trim().startsWith('<html')) {
        console.error("Received HTML response instead of JSON:", responseText.substring(0, 500));
        setError(`Server returned HTML page instead of JSON. This means:
1. The endpoint doesn't exist (check: ${url})
2. Backend server might not be running
3. The route might not be registered correctly
Status: ${response.status}`);
        setLoading(false);
        return;
      }
      
      // Try to parse as JSON
      let result;
      try {
        result = JSON.parse(responseText);
      } catch (parseError) {
        console.error("Failed to parse response as JSON:", responseText.substring(0, 500));
        setError(`Server returned invalid JSON. Response: ${responseText.substring(0, 200)}...`);
        setLoading(false);
        return;
      }
      
      if (!response.ok) {
        console.error("Error fetching today's data:", response.status, result);
        const errorMsg = `Failed to fetch today's data: ${response.status} ${response.statusText}. ${result.message || ''}`;
        setError(errorMsg);
        setLoading(false);
        return;
      }
      
      console.log("Today's data received:", JSON.stringify(result, null, 2));
      setTodayData(result);
      setLoading(false);
    } catch (error) {
      console.error("Error in fetchTodayData:", error);
      // If it's a JSON parse error, the response was likely HTML
      if (error.message.includes("Unexpected token") || error.message.includes("JSON")) {
        setError(`Server returned invalid response (likely HTML). Check:
1. Backend server is running on ${process.env.REACT_APP_FETCH_DATA_URL}
2. The endpoint /api/fitbit/${username}/activities/summary/${getCurrentDate()} exists
3. Network connection is working
Error: ${error.message}`);
      } else {
        setError(`Network error: ${error.message}. Check if backend server is running.`);
      }
      setLoading(false);
    }
  };

  const fetchWeeklyStepData = async () => {
    try {
      const date = getCurrentDate();
      // Use localhost for local development, ngrok URL only for production/external access
      const isLocalDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
      const baseUrl = isLocalDev ? 'http://localhost:5001' : (process.env.REACT_APP_FETCH_DATA_URL || 'http://localhost:5001');
      const url = `${baseUrl}/api/fitbit/${username}/activities/period/steps/date/${date}/7d`;
      console.log("Fetching weekly step data from:", url);
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'ngrok-skip-browser-warning': 'true', // Skip ngrok browser warning (if using ngrok)
        },
      });
      
      // First, get the response as text to check what we actually received
      const responseText = await response.text();
      
      // Check if we got HTML instead of JSON
      if (responseText.trim().startsWith('<!DOCTYPE') || responseText.trim().startsWith('<html')) {
        console.error("Received HTML response for weekly data:", responseText.substring(0, 500));
        return; // Don't set error for weekly data, just log it
      }
      
      if (!response.ok) {
        console.error("Error fetching weekly step data:", response.status, responseText);
        return; // Don't set error for weekly data, just log it
      }
      
      // Try to parse as JSON
      let result;
      try {
        result = JSON.parse(responseText);
      } catch (parseError) {
        console.error("Failed to parse weekly step data as JSON:", responseText.substring(0, 500));
        return;
      }
      console.log("Weekly step data received:", result);
      setWeeklyStepData(result);
    } catch (error) {
      console.error("Error in fetchWeeklyStepData:", error);
      // Don't set error for weekly data, just log it
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
      setActivitiesList(newActivitiesList);
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
        <h1>{getCurrentDate()} {currentTime}</h1>
        <h1>Today Activity Overview Dashboard</h1>
        <h1>Welcome, {username}!</h1>
      </div>
      {todayData ? (
        <div className="a-body">
          <div className="a-activities-area">
            <div className="a-activities">
              <h1>Activity</h1>
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
            <div className="a-ring-area">
              <Ring
                height="270px"
                width="230px"
                title="Calories Burned"
                current={todayData.summary.caloriesOut}
                goal={todayData.goals.caloriesOut}
              />
              <Ring
                height="270px"
                width="230px"
                title="Steps"
                current={todayData.summary.steps}
                goal={todayData.goals.steps}
              />
              <Ring
                height="270px"
                width="230px"
                title="Floors"
                current={todayData.summary.floors}
                goal={todayData.goals.floors}
              />
              <Ring
                height="270px"
                width="230px"
                title="Distance"
                current={
                  todayData.summary.distances.find(
                    (item) => item.activity === "total"
                  ).distance
                }
                goal={todayData.goals.distance}
              />
            </div>

            <div className="a-chart-area">
              {weeklyStepData && weeklyStepData["activities-steps"] && (
                <CustomLineChart
                  height={350}
                  width={900}
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
        <div>
          {loading ? (
            <div>Loading...</div>
          ) : error ? (
            <div style={{ color: 'red', padding: '20px' }}>
              <h2>Error loading data</h2>
              <p>{error}</p>
              <p>Please check:</p>
              <ul>
                <li>Backend server is running</li>
                <li>Fitbit token is valid</li>
                <li>Network connection is working</li>
              </ul>
            </div>
          ) : (
            <div>No data available</div>
          )}
        </div>
      )}
    </PageLayoutClean>
  );
};

export default TodayActivityPage;