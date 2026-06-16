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

    // get Access Token with authcode — exchange happens server-side to avoid CORS
    const fetchToken = async (code) => {
      try {
        // Always use same-origin in the browser; the backend serves this app.
        const apiBase = window.location.origin;
        const response = await fetch(
          `${apiBase.replace(/\/$/, "")}/api/login/fitbit-exchange`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code, username }),
          }
        );

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(`Token exchange failed: ${JSON.stringify(errorData)}`);
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
