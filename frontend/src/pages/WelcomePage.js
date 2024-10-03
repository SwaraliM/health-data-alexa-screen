// WelcomePage.js
import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { LOGIN_SUCCESS } from "../utils/constants";

function WelcomePage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const navigate = useNavigate();

  const handleSubmit = (e) => {
    e.preventDefault();

    fetch("/api/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username, password }),
    })
      .then((response) => response.json())
      .then((data) => {
        if (data.message == LOGIN_SUCCESS && data.isAuthorized) {
          //establish websocket
          const socket = new WebSocket(
            process.env.REACT_APP_BACKEND_WEBSOCKET_URL
          );

          socket.onopen = () => {
            socket.send(JSON.stringify({ username }));
            console.log(
              `WebSocket connection established for user: ${username}`
            );

            // nav to dashboard
            navigate(`/dashboard/${username}`);
          };
        } else if (data.message == LOGIN_SUCCESS && !data.isAuthorized) {
          navigate("/auth");
        } else {
          alert("Login failed. Please check your username and password.");
        }
      })
      .catch((error) => console.error("Error:", error));
  };

  return (
    <div>
      <h1>Welcome</h1>
      <form onSubmit={handleSubmit}>
        <div>
          <label>
            Username:
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </label>
        </div>
        <div>
          <label>
            Password:
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
        </div>
        <button type="submit">Login</button>
      </form>
    </div>
  );
}

export default WelcomePage;
