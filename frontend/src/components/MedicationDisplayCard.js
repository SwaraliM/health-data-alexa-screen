import React from "react";
import { FaPills, FaCapsules, FaSyringe, FaTint } from "react-icons/fa"; // Import icons
import "../css/medicationDisplayCard.css"; // Import CSS file for this component

const getIconForForm = (form) => {
  switch (form) {
    case "tablet":
      return <FaPills />;
    case "capsule":
      return <FaCapsules />;
    case "injection":
      return <FaSyringe />;
    case "syrup":
      return <FaTint />;
    default:
      return <FaPills />; // Default to a pill icon if the form is unknown
  }
};

const MedicationDisplayCard = ({ medication }) => {
  return (
    <div className="medication-display-card">
      <div className="medication-info-section">
        <div className="medication-name">
          {medication.name}
          <span className="medication-icon">{getIconForForm(medication.form)}</span> {/* Display icon next to the name */}
        </div>
        <p className="medication-dosage"><strong>Dosage:</strong> {medication.dosage}</p>
        <p className="medication-form"><strong>Form:</strong> {medication.form}</p>
        <p className="medication-instructions"><strong>Instructions:</strong> {medication.instructions}</p>
        
        {medication.sideEffects.length > 0 && (
          <p className="medication-sideEffects">
            <strong>Side Effects:</strong> {medication.sideEffects.join(", ")}
          </p>
        )}
        
        {medication.note && (
          <p className="medication-note"><strong>Note:</strong> {medication.note}</p>
        )}
      </div>
    </div>
  );
};

export default MedicationDisplayCard;
