import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import PageLayout from "../components/PageLayout";
import '../css/authCallback.css';

const AuthCallback = () => {
  const navigate = useNavigate();
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const authCode = urlParams.get("code");
    const username = localStorage.getItem("username");

    // get Access Token with authcode
    const fetchToken = async (code) => {
      try {
        const clientId = "23PLM3";
        const clientSecret = "c9cd4302ebcbd64bc14b8a14d84de6d6";

        // Base64 encode client_id:client_secret for the Authorization header
        const encodedCredentials = btoa(`${clientId}:${clientSecret}`);

        const response = await fetch("https://api.fitbit.com/oauth2/token", {
          method: "POST",
          headers: {
            Authorization: `Basic ${encodedCredentials}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            client_id: clientId,
            grant_type: "authorization_code",
            redirect_uri: "http://localhost:5000/auth-callback",
            code: code,
          }),
        });

        if (!response.ok) {
          throw new Error("get Token fail");
        }

        const data = await response.json();
        const { access_token, refresh_token, expires_in } = data;

        //save token
        const saveTokenResponse = await fetch(
          "http://localhost:5000/api/login/save-token",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              username: username,
              accessToken: access_token,
              refreshToken: refresh_token,
              tokenExpiry: expires_in,
            }),
          }
        );

        if (!saveTokenResponse.ok) {
          throw new Error("error in saving token");
        }

        //establish websocket
        const socket = new WebSocket(
          process.env.REACT_APP_BACKEND_WEBSOCKET_URL
        );

        socket.onopen = () => {
          socket.send(JSON.stringify({ "username": username }));
          console.log(`WebSocket connection established for user: ${username}`);
        };

        navigate(`/dashboard/${username}`);
      } catch (error) {
        console.error("error:", error);
      }
    };

    if (authCode) {
      fetchToken(authCode);
    }
  }, []);

  return (
    <PageLayout>
      <div className="auth-info">Processing, Please Wait...</div>
    </PageLayout>
  );
};

export default AuthCallback;
