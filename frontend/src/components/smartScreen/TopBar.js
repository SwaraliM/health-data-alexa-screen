import React from "react";
import { FiMic, FiUser } from "react-icons/fi";

const TopBar = ({ timeText, title, greeting = "Hi, Amy!", showAlexa = true }) => {
  return (
    <header className="ss-topbar" role="banner" aria-label={`${title} top bar`}>
      <p className="ss-topbar-time" aria-label={`Current time ${timeText}`}>
        {timeText}
      </p>
      <h1 className="ss-topbar-title">{title}</h1>
      <div className="ss-topbar-right">
        {showAlexa && (
          <span className="ss-alexa-indicator" aria-label="Alexa skill connected">
            <FiMic aria-hidden="true" /> Alexa skill
          </span>
        )}
        <span className="ss-greeting">{greeting}</span>
        <span className="ss-avatar" aria-label="User avatar placeholder">
          <FiUser aria-hidden="true" />
        </span>
      </div>
    </header>
  );
};

export default TopBar;

