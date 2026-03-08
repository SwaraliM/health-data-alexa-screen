import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import PageLayout from "../components/PageLayout";
import '../css/authCallback.css';
import { getCurrentDate } from '../utils/getCurrentDate';

const AuthCallback = () => {
  const navigate = useNavigate();
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const authCode = urlParams.get("code");
    const username = (localStorage.getItem("username") || "").trim().toLowerCase();

    // get Access Token with authcode
    const fetchToken = async (code) => {
      try {
        const clientId = process.env.REACT_APP_FITBIT_CLIENT_ID;
        const clientSecret = process.env.REACT_APP_FITBIT_CLIENT_SECRET;

        console.log('Client ID:', clientId);
        console.log('Client Secret:', clientSecret ? 'Present' : 'Missing');

        if (!clientId || !clientSecret) {
          throw new Error('Missing Fitbit credentials. Check your .env file.');
        }

        // Base64 encode client_id:client_secret for the Authorization header
        const encodedCredentials = btoa(`${clientId}:${clientSecret}`);
        console.log('Encoded credentials:', encodedCredentials);

        const response = await fetch("https://api.fitbit.com/oauth2/token", {
          method: "POST",
          headers: {
            Authorization: `Basic ${encodedCredentials}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            client_id: clientId,
            grant_type: "authorization_code",
            redirect_uri: "https://noncryptical-weston-entomophagous.ngrok-free.dev/auth-callback",
            code: code,
          }),
        });

        if (!response.ok) {
          const errorData = await response.json();
          console.error('Fitbit API Error:', errorData);
          throw new Error(`Fitbit API Error: ${JSON.stringify(errorData)}`);
        }

        const data = await response.json();
        console.log('Token response:', data);
        const { access_token, refresh_token, expires_in } = data;

        //save token
        const apiBase = process.env.REACT_APP_FETCH_DATA_URL || window.location.origin;
        const saveTokenResponse = await fetch(
          `${apiBase.replace(/\/$/, "")}/api/login/save-token`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              username: username || undefined,
              accessToken: access_token,
              refreshToken: refresh_token,
              tokenExpiry: expires_in,
            }),
          }
        );

        if (!saveTokenResponse.ok) {
          throw new Error("error in saving token");
        }


        navigate(`/dashboard/${username}`);
      } catch (error) {
        console.error("error:", error);
        alert(`OAuth Error: ${error.message}. Check console for details.`);
        navigate('/');
      }
    };

    if (!username) {
      alert("Please log in first, then connect Fitbit.");
      navigate("/");
      return;
    }
    if (authCode) {
      fetchToken(authCode);
    }
  }, [navigate]);

  return (
    <PageLayout>
      <div className="auth-info">Processing, Please Wait...</div>
    </PageLayout>
  );
};

export default AuthCallback;
