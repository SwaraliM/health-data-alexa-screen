import React, { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import PageLayout from "../components/PageLayout";
import "../css/activityPage.css";
import SmallCard from "../components/SmallCard";
import ChartCard from "../components/ChartCard";
import { FaHeart, FaFireAlt, FaWalking, FaChair, FaRoad } from "react-icons/fa";
import MedicationCard from "../components/MedicationCard";

function ActivityPage() {
  // get username from url
  const { username } = useParams();

  const [fitbitData, setFitbitData] = useState(null);

  useEffect(() => {
    const fetchFitbitData = async () => {
      try {
        let data;
        data = {
          activities: [],
          goals: {
            activeMinutes: 30,
            caloriesOut: 2588,
            distance: 8.05,
            steps: 10000,
          },
          summary: {
            activeScore: -1,
            activityCalories: 0,
            caloriesBMR: 1196,
            caloriesOut: 1196,
            distances: [
              {
                activity: "total",
                distance: 0,
              },
              {
                activity: "tracker",
                distance: 0,
              },
              {
                activity: "loggedActivities",
                distance: 0,
              },
              {
                activity: "veryActive",
                distance: 0,
              },
              {
                activity: "moderatelyActive",
                distance: 0,
              },
              {
                activity: "lightlyActive",
                distance: 0,
              },
              {
                activity: "sedentaryActive",
                distance: 0,
              },
            ],
            fairlyActiveMinutes: 0,
            lightlyActiveMinutes: 0,
            marginalCalories: 0,
            sedentaryMinutes: 928,
            steps: 0,
            veryActiveMinutes: 0,
          },
        };
        setFitbitData(data);
      } catch (error) {
        console.error("Error fetching Fitbit data:", error);
      }
    };

    fetchFitbitData();
  }, [username]);

  return (
    <PageLayout>
      <div className="header">
        <div className="title">Activity</div>
        <div className="welcome">Welcome, {username}!</div>
      </div>
      {fitbitData ? (
        <div className="body">
          
        </div>
      ) : (
        <p>Loading Fitbit data...</p>
      )}
    </PageLayout>
  );
}

export default ActivityPage;
