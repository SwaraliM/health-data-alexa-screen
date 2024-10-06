import { useEffect } from "react";
import PageLayout from "../components/PageLayout";
import '../css/authPage.css';

const AuthPage = () => {
  useEffect(() => {
    const fitbitAuthUrl = process.env.REACT_APP_FITBIT_AUTH_URL;

    // redirect to fitbit auth url
    window.location.href = fitbitAuthUrl;
  }, []);

  return (
    <PageLayout>
      <div className="auth-info">Redirecting to Fitbit Authentication Page, Please Wait...</div>
    </PageLayout>
  );
};

export default AuthPage;
