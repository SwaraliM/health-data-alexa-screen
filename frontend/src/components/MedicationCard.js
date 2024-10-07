import React from 'react';
import Card from './Card';
import { FaCheckCircle, FaTimesCircle } from 'react-icons/fa'; 
import '../css/medicationCard.css';
import { FaPills, FaCapsules, FaSyringe, FaTint } from 'react-icons/fa';

const MedicationCard = ({ medicationSections, backgroundColor }) => {

    medicationSections = medicationSections == null? [
        {
          subtitle: "Morning",
          list: [
            {
              name: "Aspirin",
              icon: <FaPills />,
              note: "Take with a full glass of water",
              taken: true,
            },
            {
              name: "Vitamin D",
              icon: <FaCapsules />,
              note: "Take after breakfast",
              taken: false,
            },
          ],
        },
        {
          subtitle: "Lunch",
          list: [
            {
              name: "Insulin",
              icon: <FaSyringe />,
              note: "Administer before lunch",
              taken: true,
            },
          ],
        },
        {
          subtitle: "Dinner",
          list: [
            {
              name: "Omega-3",
              icon: <FaTint />,
              note: "Take with dinner",
              taken: false,
            },
            {
              name: "Calcium",
              icon: <FaCapsules />,
              note: "Take after meal",
              taken: true,
            },
          ],
        },
      ] : medicationSections;


  return (
    <Card width="400px" height="600px" backgroundColor={backgroundColor}>
      <div className="medication-card">
        {medicationSections.map((section, index) => (
          <div key={index} className="medication-section">
            <div className='section-title'>{section.subtitle}</div>
            <div className="medication-list">
              {section.list.map((medication, medIndex) => (
                <div key={medIndex} className="medication-item">
                  <div className="medication-icon">{medication.icon}</div>
                  <div className="medication-info">
                    <div className="med-card-medication-name">{medication.name}</div>
                    <div className="med-card-medication-note">{medication.note}</div>
                  </div>
                  <div className="medication-status">
                    {medication.taken ? (
                      <FaCheckCircle className="taken" />
                    ) : (
                      <FaTimesCircle className="not-taken" />
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
};

export default MedicationCard;
