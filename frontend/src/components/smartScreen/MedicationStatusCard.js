import React from "react";
import { FiCheckCircle, FiClock } from "react-icons/fi";

const MedicationStatusCard = ({ medsDue = false }) => {
  return (
    <section className="ss-card ss-med-card" aria-label="Medication status">
      <h2>Medication</h2>
      {medsDue ? (
        <div className="ss-med-state">
          <FiClock aria-hidden="true" />
          <p>Next dose at 1:00 PM</p>
          <p>2 pills</p>
        </div>
      ) : (
        <div className="ss-med-state">
          <FiCheckCircle aria-hidden="true" />
          <p>You are all set!</p>
        </div>
      )}
    </section>
  );
};

export default MedicationStatusCard;

