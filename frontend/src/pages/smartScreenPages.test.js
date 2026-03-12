import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import DashboardPage from "./DashboardPage";
import ReminderPage from "./ReminderPage";
import QnAPage from "./QnAPage";

jest.mock("echarts-for-react", () => (props) => (
  <div data-testid="mock-echart" aria-label={props?.option?.title?.text || "Mock chart"} />
));

jest.mock("@ant-design/plots", () => ({
  Line: () => <div>Mock Trend Line</div>,
  Column: () => <div>Mock Trend Column</div>,
  Area: () => <div>Mock Trend Area</div>,
}));

describe("Smart screen page smoke tests", () => {
  let speechSynthesisMock;

  beforeEach(() => {
    sessionStorage.clear();
    jest.restoreAllMocks();
    speechSynthesisMock = {
      speak: jest.fn(),
      cancel: jest.fn(),
    };
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: speechSynthesisMock,
    });
    Object.defineProperty(window, "SpeechSynthesisUtterance", {
      configurable: true,
      value: jest.fn(function SpeechSynthesisUtterance(text) {
        this.text = text;
      }),
    });
  });

  test("renders dashboard page shell", async () => {
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    );

    expect(screen.getByRole("heading", { name: "Today's Overview" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Today's Insight" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Open weekly trends" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Reminders" })).toBeTruthy();
  });

  test("renders medication reminder variant by default", () => {
    render(
      <MemoryRouter initialEntries={["/reminder"]}>
        <ReminderPage />
      </MemoryRouter>
    );

    expect(screen.getByRole("heading", { name: "Reminders" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Mark taken" })).toBeTruthy();
  });

  test("renders QnA chart-first shell", () => {
    render(
      <MemoryRouter>
        <QnAPage />
      </MemoryRouter>
    );

    expect(screen.getByRole("heading", { name: "Health Q and A" })).toBeTruthy();
    expect(screen.getAllByText("Chart view will appear here when a health question is answered.").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Tap to speak" })).toBeNull();
  });

  test("updates QnA page when qnaDataUpdated event is fired", async () => {
    sessionStorage.setItem(
      "qnaData",
      JSON.stringify({
        question: "How did I sleep?",
        response_mode: "multi_panel_report",
        layout: "two_up",
        report_title: "Your health at a glance",
        takeaway: "Sleep improved.",
        spoken_answer: "Sleep improved.",
        panels: [
          {
            panel_id: "sleep_summary",
            title: "Sleep - Last 7 days",
            subtitle: "Last 7 days",
            goal: "single_metric_status",
            metrics: ["sleep_minutes"],
            visual_family: "bar",
            chart_spec: {
              chart_type: "bar",
              title: "Sleep - Last 7 days",
              subtitle: "Last 7 days",
              takeaway: "Sleep improved.",
              option: {
                xAxis: { data: ["M", "T", "W"] },
                yAxis: { type: "value" },
                series: [{ type: "bar", data: [6.2, 7.1, 7.4] }],
              },
            },
          },
          {
            panel_id: "sleep_compare",
            title: "Sleep vs previous",
            subtitle: "Last 7 days compared with prior",
            goal: "comparison_report",
            metrics: ["sleep_minutes"],
            visual_family: "grouped_bar",
            chart_spec: {
              chart_type: "grouped_bar",
              title: "Sleep vs previous",
              subtitle: "Last 7 days compared with prior",
              takeaway: "Sleep improved.",
              option: {
                xAxis: { data: ["M", "T", "W"] },
                yAxis: { type: "value" },
                series: [{ type: "bar", data: [6.1, 6.9, 7.1] }],
              },
            },
          },
        ],
      })
    );

    render(
      <MemoryRouter>
        <QnAPage />
      </MemoryRouter>
    );

    expect(await screen.findByRole("heading", { level: 2, name: "Your health at a glance" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: "Sleep - Last 7 days" })).toBeTruthy();

    sessionStorage.setItem(
      "qnaData",
      JSON.stringify({
        question: "How active was I?",
        response_mode: "single_view",
        layout: "single_focus",
        report_title: "Steps report",
        takeaway: "Activity was steady.",
        spoken_answer: "Activity was steady.",
        panels: [
          {
            panel_id: "steps_summary",
            title: "Steps - Last 7 days",
            subtitle: "Last 7 days",
            goal: "single_metric_status",
            metrics: ["steps"],
            visual_family: "bar",
            chart_spec: {
              chart_type: "bar",
              title: "Steps - Last 7 days",
              subtitle: "Last 7 days",
              takeaway: "Activity was steady.",
              option: {
                xAxis: { data: ["M", "T", "W"] },
                yAxis: { type: "value" },
                series: [{ type: "bar", data: [5600, 6100, 5800] }],
              },
            },
          },
        ],
      })
    );

    act(() => {
      window.dispatchEvent(new CustomEvent("qnaDataUpdated"));
    });

    expect(await screen.findByRole("heading", { level: 2, name: "Steps report" })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 3, name: "Steps - Last 7 days" })).toBeNull();
    expect(document.querySelector(".hd-panel-grid-single_focus")).toBeTruthy();
    expect(document.querySelector(".hd-main-single-panel")).toBeTruthy();
    expect(document.querySelector(".hd-panel-card-single-panel")).toBeTruthy();
    expect(document.querySelector(".hd-panel-chart-single-panel")).toBeTruthy();
  });

  test("shows the slow-status banner when a delayed update arrives", async () => {
    render(
      <MemoryRouter>
        <QnAPage />
      </MemoryRouter>
    );

    act(() => {
      window.dispatchEvent(new CustomEvent("visualStatusUpdate", {
        detail: {
          type: "slow",
          message: "This is taking a little longer. I will read the answer as soon as it is ready.",
        },
      }));
    });

    expect(await screen.findByText("This is taking a little longer. I will read the answer as soon as it is ready.")).toBeTruthy();
    expect(document.querySelector(".hd-ready-banner.slow")).toBeTruthy();
  });

  test("auto-speaks a ready answer once per request", async () => {
    jest.useFakeTimers();
    sessionStorage.setItem(
      "qnaData",
      JSON.stringify({
        requestId: "req-auto-speak",
        answer_ready: true,
        response_mode: "single_view",
        layout: "single_focus",
        report_title: "Sleep detail",
        takeaway: "Sleep improved.",
        spoken_answer: "Sleep improved.",
        panels: [{
          panel_id: "sleep_detail",
          title: "Sleep detail",
          subtitle: "Last night",
          goal: "single_metric_status",
          metrics: ["sleep_minutes"],
          visual_family: "line",
          chart_spec: {
            chart_type: "line",
            title: "Sleep detail",
            subtitle: "Last night",
            takeaway: "Sleep improved.",
            option: {
              xAxis: { data: ["11 PM", "1 AM"] },
              yAxis: { type: "value" },
              series: [{ type: "line", data: [1, 2] }],
            },
          },
        }],
      })
    );

    render(
      <MemoryRouter>
        <QnAPage />
      </MemoryRouter>
    );

    await screen.findByRole("heading", { level: 2, name: "Sleep detail" });

    act(() => {
      jest.advanceTimersByTime(250);
    });

    expect(window.speechSynthesis.cancel).toHaveBeenCalledTimes(1);
    expect(window.speechSynthesis.speak).toHaveBeenCalledTimes(1);
    expect(window.speechSynthesis.speak.mock.calls[0][0].text).toBe("Sleep improved.");

    act(() => {
      window.dispatchEvent(new CustomEvent("qnaDataUpdated"));
      jest.advanceTimersByTime(250);
    });

    expect(window.speechSynthesis.speak).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  test("renders multi-panel report payload", async () => {
    sessionStorage.setItem(
      "qnaData",
      JSON.stringify({
        question: "Show trend",
        response_mode: "multi_panel_report",
        layout: "three_panel_report",
        report_title: "Weekly report",
        takeaway: "Activity and sleep both improved.",
        spoken_answer: "Activity and sleep both improved.",
        panels: [
          {
            panel_id: "stage_1",
            title: "Stage 1",
            subtitle: "Now",
            goal: "comparison_report",
            metrics: ["steps"],
            visual_family: "line",
            emphasis: "hero",
            chart_spec: {
              chart_type: "line",
              title: "Stage 1",
              subtitle: "Now",
              takeaway: "Stage 1 takeaway",
              option: {
                xAxis: { data: ["M", "T"] },
                yAxis: { type: "value" },
                series: [{ type: "line", data: [1, 2] }],
              },
            },
          },
          {
            panel_id: "stage_2",
            title: "Stage 2",
            subtitle: "Later",
            goal: "comparison_report",
            metrics: ["sleep_minutes"],
            visual_family: "line",
            chart_spec: {
              chart_type: "line",
              title: "Stage 2",
              subtitle: "Later",
              takeaway: "Stage 2 takeaway",
              option: {
                xAxis: { data: ["M", "T"] },
                yAxis: { type: "value" },
                series: [{ type: "line", data: [3, 4] }],
              },
            },
          },
          {
            panel_id: "stage_3",
            title: "Stage 3",
            subtitle: "Footer",
            goal: "relationship_report",
            metrics: ["steps", "sleep_minutes"],
            visual_family: "scatter",
            chart_spec: {
              chart_type: "scatter",
              title: "Stage 3",
              subtitle: "Footer",
              takeaway: "Stage 3 takeaway",
              option: {
                xAxis: { type: "value" },
                yAxis: { type: "value" },
                series: [{ type: "scatter", data: [[1, 2], [3, 4]] }],
              },
            },
          },
        ],
      })
    );

    render(
      <MemoryRouter>
        <QnAPage />
      </MemoryRouter>
    );

    expect(await screen.findByRole("heading", { level: 2, name: "Weekly report" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: "Stage 1" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: "Stage 2" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: "Stage 3" })).toBeTruthy();
    expect(screen.getAllByText("Activity and sleep both improved.").length).toBeGreaterThan(0);
    expect(document.querySelector(".hd-panel-grid-three_panel_report")).toBeTruthy();
    expect(document.querySelector(".hd-panel-emphasis-hero")).toBeTruthy();
  });

  test("renders four-panel payload with panel-count-aware grid class", async () => {
    sessionStorage.setItem(
      "qnaData",
      JSON.stringify({
        response_mode: "multi_panel_report",
        layout: "four_panel_grid",
        report_title: "Four panel report",
        takeaway: "A broader summary is shown.",
        spoken_answer: "A broader summary is shown.",
        panels: [1, 2, 3, 4].map((idx) => ({
          panel_id: `panel_${idx}`,
          title: `Panel ${idx}`,
          subtitle: "Now",
          goal: "single_metric_status",
          metrics: ["steps"],
          visual_family: "line",
          chart_spec: {
            chart_type: "line",
            title: `Panel ${idx}`,
            subtitle: "Now",
            takeaway: `Panel ${idx} takeaway`,
            option: {
              xAxis: { data: ["M", "T"] },
              yAxis: { type: "value" },
              series: [{ type: "line", data: [idx, idx + 1] }],
            },
          },
        })),
      })
    );

    render(
      <MemoryRouter>
        <QnAPage />
      </MemoryRouter>
    );

    expect(await screen.findByRole("heading", { level: 2, name: "Four panel report" })).toBeTruthy();
    expect(document.querySelector(".hd-panel-grid-four_panel_grid")).toBeTruthy();
    expect(document.querySelector(".hd-panel-count-4")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: "Panel 4" })).toBeTruthy();
  });

  test("does not render GPT trace when debug data is present", async () => {
    sessionStorage.setItem(
      "qnaData",
      JSON.stringify({
        response_mode: "single_view",
        layout: "single_focus",
        report_title: "Sleep detail",
        takeaway: "Sleep quality looked fairly strong.",
        spoken_answer: "Sleep quality looked fairly strong.",
        debug: {
          gpt_trace: {
            planner: {
              status: "ok",
              used_fallback: false,
              request_summary: "planner request",
              response_summary: "planner response",
              error_message: "",
            },
          },
        },
        panels: [{
          panel_id: "sleep_detail",
          title: "Sleep detail",
          subtitle: "Last night",
          goal: "deep_dive",
          metrics: ["sleep_minutes"],
          visual_family: "timeline",
          chart_spec: {
            chart_type: "timeline",
            title: "Sleep detail",
            subtitle: "Last night",
            takeaway: "Sleep quality looked fairly strong.",
            panel_theme: {
              accentColor: "#5B6CFF",
              borderColor: "#5B6CFF33",
              backgroundColor: "#EEF2FF",
            },
            option: {
              xAxis: { data: ["11 PM", "1 AM"] },
              yAxis: { type: "value" },
              series: [{ type: "line", data: [1, 2] }],
            },
          },
        }],
      })
    );

    render(
      <MemoryRouter>
        <QnAPage />
      </MemoryRouter>
    );

    expect(await screen.findByRole("heading", { level: 2, name: "Sleep detail" })).toBeTruthy();
    expect(screen.queryByText("GPT trace")).toBeNull();
    expect(screen.queryByText(/planner request/i)).toBeNull();
    expect(document.querySelector(".hd-panel-grid-single_focus")).toBeTruthy();
  });

  test("does not crash when qnaData is malformed JSON", async () => {
    sessionStorage.setItem("qnaData", "{bad-json");

    render(
      <MemoryRouter>
        <QnAPage />
      </MemoryRouter>
    );

    expect(await screen.findByRole("heading", { name: "Health Q and A" })).toBeTruthy();
    expect(screen.getAllByText("Chart view will appear here when a health question is answered.").length).toBeGreaterThan(0);
  });
});
