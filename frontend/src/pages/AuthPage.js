import { useEffect } from 'react';

const AuthPage = () => {
  useEffect(() => {
    const fitbitAuthUrl = process.env.REACT_APP_FITBIT_AUTH_URL;

    // redirect to fitbit auth url
    window.location.href = fitbitAuthUrl;
  }, []);

  return <div>redirecting to Fitbit Authentication Page, Please wait...</div>;
};

export default AuthPage;
