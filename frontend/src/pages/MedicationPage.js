import React, { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import PageLayout from "../components/PageLayout";
import MedicationDisplayCard from "../components/MedicationDisplayCard"; // Use the new MedicationDisplayCard component
import "../css/medicationPage.css"; // Import CSS for the MedicationPage

const MedicationPage = () => {
  const { username } = useParams(); // Get username from the URL
  const [medications, setMedications] = useState([]); // State to store medication data
  const [loading, setLoading] = useState(true); // Loading state
  const [error, setError] = useState(null); // Error state

  // Fetch medication data from the backend
  useEffect(() => {
    const fetchMedications = async () => {
      try {
        const response = await fetch(`/api/med/all/${username}`); // Fetch medication data based on username
        if (!response.ok) {
          throw new Error("Failed to fetch medication data"); // Handle fetch errors
        }
        const data = await response.json(); // Parse response data
        setMedications(data); // Set medication data to state
        setLoading(false); // Stop loading
      } catch (err) {
        setError("Error fetching medications"); // Set error state if fetch fails
        setLoading(false); // Stop loading
      }
    };

    fetchMedications();
  }, [username]); // Re-run the effect when the username changes

  // Show loading message while fetching data
  if (loading) {
    return (
      <PageLayout>
        <p>Loading medications...</p>
      </PageLayout>
    );
  }

  // Show error message if there was an issue fetching data
  if (error) {
    return (
      <PageLayout>
        <p>{error}</p>
      </PageLayout>
    );
  }

  // Render medication data using MedicationDisplayCard layout
  return (
    <PageLayout>
      <div className="header">
        <div className="title">Medication List</div>
        <div className="welcome">Welcome, {username}!</div>
      </div>
      <div className="body">
        <div className="medication-list">
          {medications.map((medication, index) => (
            <MedicationDisplayCard key={index} medication={medication} />
          ))}
        </div>
      </div>
    </PageLayout>
  );
};

export default MedicationPage;
