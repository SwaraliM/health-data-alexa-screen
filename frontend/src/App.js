import { BrowserRouter as Router, Route, Routes } from "react-router-dom";
import WelcomePage from "./pages/WelcomePage";
import AuthPage from "./pages/AuthPage";
import AuthCallback from "./pages/AuthCallback";
import DashboardPage from "./pages/Dashboard";
import "./App.css"
import "./css/fonts.css";
import "./css/colors.css";
import MedicationPage from "./pages/MedicationPage";

function App() {
  return (
    <div className="App">
      <Router>
        <Routes>
          <Route path="/" element={<WelcomePage />} />
          <Route path="/auth" element={<AuthPage />} />
          <Route path="/auth-callback" element={<AuthCallback />} />
          <Route path="/dashboard/:username" element={<DashboardPage />} />
          <Route path="/medication/:username" element={<MedicationPage />} />
        </Routes>
      </Router>
    </div>
  );
}

export default App;
