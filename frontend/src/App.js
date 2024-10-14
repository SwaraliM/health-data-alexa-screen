import { BrowserRouter as Router, Route, Routes } from "react-router-dom";
import WelcomePage from "./pages/WelcomePage";
import AuthPage from "./pages/AuthPage";
import AuthCallback from "./pages/AuthCallback";
import DashboardPage from "./pages/Dashboard";
import "./App.css";
import "./css/fonts.css";
import "./css/colors.css";
import MedicationPage from "./pages/MedicationPage";
import { connectWebSocket } from "./utils/websocket";
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

function Root() {
  const navigate = useNavigate();

  useEffect(() => {
    // check if username existed in localStorage
    const username = localStorage.getItem("username");
    if (username) {
      connectWebSocket(username, navigate); // pass navigate to for navigation
    }

    // listen to the username, once it changes, connect ws
    const storageListener = (event) => {
      if (event.key === "username" && event.newValue) {
        connectWebSocket(event.newValue, navigate);
      }
    };

    window.addEventListener("storage", storageListener);

    // clean storage listener
    return () => {
      window.removeEventListener("storage", storageListener);
    };
  }, [navigate]);

  return (
    <Routes>
      <Route path="/" element={<WelcomePage />} />
      <Route path="/auth" element={<AuthPage />} />
      <Route path="/auth-callback" element={<AuthCallback />} />
      <Route path="/dashboard/:username" element={<DashboardPage />} />
      <Route path="/medication/:username" element={<MedicationPage />} />
    </Routes>
  );
}

function App() {
  return (
    <div className="App">
      <Router>
        <Root />
      </Router>
    </div>
  );
}

export default App;
