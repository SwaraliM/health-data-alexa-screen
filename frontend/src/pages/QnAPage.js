import React from "react";
import { FiHelpCircle } from "react-icons/fi";
import SmartScreenShell from "../components/smartScreen/SmartScreenShell";
import TopBar from "../components/smartScreen/TopBar";
import { SleepComparisonPanel, StepsComparisonPanel } from "../components/smartScreen/QnAMetricPanel";

const QnAPage = () => {
  return (
    <SmartScreenShell>
      <TopBar timeText="11:11 AM" title="Response" showAlexa={false} />

      <section className="ss-card ss-question-row" aria-label="Question asked">
        <FiHelpCircle aria-hidden="true" />
        <p>Compare my health this week to last week</p>
      </section>

      <section className="ss-grid-2" aria-label="Comparison metrics">
        <StepsComparisonPanel />
        <SleepComparisonPanel />
      </section>

      <section className="ss-card ss-interpretation" aria-label="Interpretation">
        <h2>Interpretation</h2>
        <p>You are sleeping more but moving less.</p>
        <p className="ss-suggestion-pill">Suggestion: Add a 10 min walk per day</p>
      </section>
    </SmartScreenShell>
  );
};

export default QnAPage;

