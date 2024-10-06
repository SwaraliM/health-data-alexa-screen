import React from "react";
import Card from "./Card";
import "../css/smallCard.css";

const SmallCard = ({ backgroundColor, title, icon, iconColor, value, fontColor }) => {
  return (
    <Card width="230px" height="150px" backgroundColor={backgroundColor}>
      <div className="small-card-content">
        <div className="small-card-title-row">
          <div className="small-card-icon" style={{ color: `var(${iconColor})` }}>
            {icon}
          </div>
          <div className="small-card-title" style={{ color: `var(${fontColor})` }}>
            {title}
          </div>
        </div>
        <div className="small-card-value" style={{ color: `var(${fontColor})` }}>
          {value}
        </div>
      </div>
    </Card>
  );
};

export default SmallCard;
