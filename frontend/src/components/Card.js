import React from 'react';
import '../css/card.css'; 

const Card = ({ width, height, backgroundColor, children }) => {
  return (
    <div
      className="card"
      style={{
        width: width,
        height: height,
        backgroundColor: backgroundColor,
      }}
    >
      {children}
    </div>
  );
};

export default Card;
