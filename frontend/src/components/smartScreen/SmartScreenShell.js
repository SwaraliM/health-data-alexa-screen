import React from "react";
import "../../css/smartScreen.css";

const SmartScreenShell = ({ children }) => {
  return (
    <main className="ss-shell" aria-label="Alexa smart screen health interface">
      <div className="ss-canvas">{children}</div>
    </main>
  );
};

export default SmartScreenShell;

