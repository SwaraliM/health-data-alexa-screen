import React, { useMemo, useState } from "react";
import { FiMic } from "react-icons/fi";
import SmartScreenShell from "../components/smartScreen/SmartScreenShell";
import TopBar from "../components/smartScreen/TopBar";
import InsightCard from "../components/smartScreen/InsightCard";
import QuickStatTile from "../components/smartScreen/QuickStatTile";
import WeeklyActivityCard from "../components/smartScreen/WeeklyActivityCard";
import MedicationStatusCard from "../components/smartScreen/MedicationStatusCard";
import ModalDialog from "../components/smartScreen/ModalDialog";

const DashboardPage = () => {
  const [showWhy, setShowWhy] = useState(false);
  const [showGoal, setShowGoal] = useState(false);
  const [goal, setGoal] = useState(5000);

  const stepProgress = useMemo(() => (4000 / goal) * 100, [goal]);

  const handleAskAlexa = () => {
    // TODO: Wire to voice input or navigation to Q&A page
    console.log("Ask Alexa clicked");
  };

  return (
    <SmartScreenShell>
      <TopBar timeText="10:10 AM" title="Today's Overview" />

      <div className="ss-primary-action-wrap">
        <button
          type="button"
          className="ss-btn ss-btn-primary ss-btn-alexa"
          onClick={handleAskAlexa}
          aria-label="Ask Alexa a question about your health"
        >
          <FiMic aria-hidden="true" />
          Ask Alexa
        </button>
      </div>

      <InsightCard onWhyClick={() => setShowWhy(true)} onAdjustGoalClick={() => setShowGoal(true)} />

      <section className="ss-grid-4" aria-label="Quick stats">
        <QuickStatTile title="Steps" value="4,000" unit="steps" goalText={`Goal ${goal.toLocaleString()}`} progressPercent={stepProgress} />
        <QuickStatTile title="Sleep" value="6h 12m" goalText="Last night" progressPercent={88} />
        <QuickStatTile title="Distance" value="3.1" unit="mi" goalText="Goal 8 mi" progressPercent={39} />
        <QuickStatTile title="Floors" value="5" goalText="Goal 10" progressPercent={50} />
      </section>

      <section className="ss-grid-2" aria-label="Weekly and medication summary">
        <WeeklyActivityCard />
        <MedicationStatusCard medsDue={false} />
      </section>

      <ModalDialog title="Why this suggestion?" open={showWhy} onClose={() => setShowWhy(false)}>
        <p>Your sleep was below your target and recent activity has been moderate. Light cardio plus hydration is a low-effort way to improve energy today.</p>
      </ModalDialog>

      <ModalDialog title="Adjust daily step goal" open={showGoal} onClose={() => setShowGoal(false)}>
        <label className="ss-field-label" htmlFor="goal-slider">
          Daily step goal: {goal.toLocaleString()}
        </label>
        <input
          id="goal-slider"
          type="range"
          min="3000"
          max="10000"
          step="500"
          value={goal}
          onChange={(event) => setGoal(Number(event.target.value))}
          className="ss-slider"
          aria-label="Adjust step goal"
        />
      </ModalDialog>
    </SmartScreenShell>
  );
};

export default DashboardPage;

