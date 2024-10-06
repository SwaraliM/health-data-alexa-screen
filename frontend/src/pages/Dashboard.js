import React, { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import PageLayout from "../components/PageLayout";
import "../css/dashboard.css";
import SmallCard from "../components/SmallCard";
import ChartCard from "../components/ChartCard";
import { FaHeart, FaFireAlt, FaWalking, FaChair, FaRoad } from "react-icons/fa";
import MedicationCard from "../components/MedicationCard";

function DashboardPage() {
  // get username from url
  const { username } = useParams();

  const [fitbitData, setFitbitData] = useState(null);

  useEffect(() => {
    const fetchFitbitData = async () => {
      try {
        const response = await fetch(
          `http://localhost:5000/api/fitbit/${username}/activities/today`
        );
        if (!response.ok) {
          throw new Error("Failed to fetch Fitbit data");
        }
        const data = await response.json();
        console.log("data: " + JSON.stringify(data, null, 2));
        console.log("data-summary: " + JSON.stringify(data.summary, null, 2));
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
        <div className="title">Dashboard</div>
        <div className="welcome">Welcome, {username}!</div>
      </div>
      {fitbitData ? (
        <div className="body">
          <div className="small-card-row">
            <>
              <SmallCard
                title="Steps"
                icon={<FaWalking />}
                iconColor="--dark-blue-color"
                value={`${fitbitData.summary.steps}`}
                fontColor="--dark-blue-color"
              />
              <SmallCard
                title="Calorie"
                icon={<FaFireAlt />}
                iconColor="--dark-blue-color"
                value={`${fitbitData.summary.caloriesOut}`}
                fontColor="--dark-blue-color"
              />
              <SmallCard
                title="Distance"
                icon={<FaRoad />}
                iconColor="--dark-blue-color"
                value={`${fitbitData.summary.distances[0].distance} km`}
                fontColor="--dark-blue-color"
              />
              <SmallCard
                title="Active"
                icon={<FaHeart />}
                iconColor="--dark-blue-color"
                value={`${fitbitData.summary.veryActiveMinutes} min`}
                fontColor="--dark-blue-color"
              />
              <SmallCard
                title="Sedentary"
                icon={<FaChair />}
                iconColor="--dark-blue-color"
                value={`${fitbitData.summary.sedentaryMinutes} min`}
                fontColor="--dark-blue-color"
              />
            </>
          </div>
          <div className="big-card-row">
            <div className="chart-col">
            <ChartCard/>
            <ChartCard/>
            </div>
            <div className="list-col">
              <MedicationCard/>
            </div>
          </div>
        </div>
      ) : (
        <p>Loading Fitbit data...</p>
      )}
    </PageLayout>
  );
}

export default DashboardPage;
