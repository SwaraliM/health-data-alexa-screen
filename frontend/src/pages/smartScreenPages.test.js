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
  beforeEach(() => {
    sessionStorage.clear();
    jest.restoreAllMocks();
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

    expect(screen.getByRole("heading", { name: "Health Assistant" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Tap to speak" })).toBeTruthy();
    expect(screen.getByText("Ask a question and I'll summarize it in one or two sentences.")).toBeTruthy();
  });

  test("updates QnA page when qnaDataUpdated event is fired", async () => {
    sessionStorage.setItem(
      "qnaData",
      JSON.stringify({
        question: "How did I sleep?",
        voice_answer: "Sleep improved.",
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
      })
    );

    render(
      <MemoryRouter>
        <QnAPage />
      </MemoryRouter>
    );

    expect(await screen.findByRole("heading", { level: 2, name: "Sleep - Last 7 days" })).toBeTruthy();

    sessionStorage.setItem(
      "qnaData",
      JSON.stringify({
        question: "How active was I?",
        voice_answer: "Activity was steady.",
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
      })
    );

    act(() => {
      window.dispatchEvent(new CustomEvent("qnaDataUpdated"));
    });

    expect(await screen.findByRole("heading", { level: 2, name: "Steps - Last 7 days" })).toBeTruthy();
  });

  test("applies stage chart spec on qnaStage event", async () => {
    sessionStorage.setItem(
      "qnaData",
      JSON.stringify({
        question: "Show trend",
        activeStageIndex: 0,
        stages: [
          {
            id: "stage_1",
            cue: "First cue",
            speech: "First speech",
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
            id: "stage_2",
            cue: "Second cue",
            speech: "Second speech",
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
        ],
      })
    );

    render(
      <MemoryRouter>
        <QnAPage />
      </MemoryRouter>
    );

    expect(await screen.findByRole("heading", { level: 2, name: "Stage 1" })).toBeTruthy();

    act(() => {
      window.dispatchEvent(new CustomEvent("qnaStage", { detail: { stageIndex: 1, speech: "Second speech" } }));
    });

    expect(await screen.findByRole("heading", { level: 2, name: "Stage 2" })).toBeTruthy();
    expect(screen.getAllByText("Second speech").length).toBeGreaterThan(0);
  });

  test("does not crash when qnaData is malformed JSON", async () => {
    sessionStorage.setItem("qnaData", "{bad-json");

    render(
      <MemoryRouter>
        <QnAPage />
      </MemoryRouter>
    );

    expect(await screen.findByRole("heading", { name: "Health Assistant" })).toBeTruthy();
    expect(screen.getByText("Ask a question and I'll summarize it in one or two sentences.")).toBeTruthy();
  });
});
