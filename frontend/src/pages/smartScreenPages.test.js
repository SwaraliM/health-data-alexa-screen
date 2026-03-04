import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import DashboardPage from "./DashboardPage";
import ReminderPage from "./ReminderPage";
import QnAPage from "./QnAPage";

jest.mock("../components/CustomLineChart", () => () => <div>Mock Line Chart</div>);
jest.mock("../components/CustomPie", () => () => <div>Mock Pie Chart</div>);
jest.mock("../components/Ring", () => () => <div>Mock Ring Chart</div>);
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
    expect(screen.queryByRole("button", { name: "Adjust step goal" })).toBeNull();
    expect(await screen.findByRole("button", { name: "Open weekly trends" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Reminders" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ask Alexa" })).toBeNull();
    expect(screen.queryByText(/Alexa skill/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Add reminder" })).toBeNull();
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

  test("renders QnA response page", () => {
    render(
      <MemoryRouter>
        <QnAPage />
      </MemoryRouter>
    );
    expect(screen.getByRole("heading", { name: "Health Assistant" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ask Question" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send question" })).toBeTruthy();
  });

  test("updates QnA page when qnaDataUpdated event is fired", async () => {
    sessionStorage.setItem(
      "qnaData",
      JSON.stringify({
        summary: { shortText: "Sleep improved." },
        activeStageIndex: 0,
        stages: [
          {
            id: "stage_1",
            cue: "Sleep cue",
            speech: "Sleep improved.",
            components: [{ component: "SingleValue", data: { title: "Sleep", value: 7 } }],
          },
        ],
      })
    );

    render(
      <MemoryRouter>
        <QnAPage />
      </MemoryRouter>
    );

    expect(await screen.findByRole("heading", { level: 2, name: "Sleep" })).toBeTruthy();

    sessionStorage.setItem(
      "qnaData",
      JSON.stringify({
        summary: { shortText: "Activity stable." },
        activeStageIndex: 0,
        stages: [
          {
            id: "stage_1",
            cue: "Activity cue",
            speech: "Activity stable.",
            components: [{ component: "SingleValue", data: { title: "Activity", value: 1 } }],
          },
        ],
      })
    );

    act(() => {
      window.dispatchEvent(new CustomEvent("qnaDataUpdated"));
    });

    expect(await screen.findByRole("heading", { level: 2, name: "Activity" })).toBeTruthy();
  });

  test("reveals staged qna visuals on qnaStage event and supports navigation", async () => {
    sessionStorage.setItem(
      "qnaData",
      JSON.stringify({
        question: "How did I do this week?",
        summary: { shortText: "Quick summary." },
        activeStageIndex: 0,
        stages: [
          {
            id: "stage_1",
            cue: "First cue",
            speech: "First speech",
            components: [{ component: "SingleValue", data: { title: "Steps", value: 5000 } }],
          },
          {
            id: "stage_2",
            cue: "Second cue",
            speech: "Second speech",
            components: [{ component: "SingleValue", data: { title: "Sleep", value: 7 } }],
          },
        ],
      })
    );

    render(
      <MemoryRouter>
        <QnAPage />
      </MemoryRouter>
    );

    expect(await screen.findByRole("heading", { level: 2, name: "Steps" })).toBeTruthy();

    act(() => {
      window.dispatchEvent(new CustomEvent("qnaStage", { detail: { stageIndex: 1, cue: "Second cue" } }));
    });

    expect(await screen.findByRole("heading", { level: 2, name: "Sleep" })).toBeTruthy();

    const prev = screen.getByRole("button", { name: /Previous/i });
    act(() => {
      prev.click();
    });
    expect(await screen.findByRole("heading", { level: 2, name: "Steps" })).toBeTruthy();
  });

  test("shows stage speech in chat from qna data", async () => {
    sessionStorage.setItem(
      "qnaData",
      JSON.stringify({
        question: "How is my week?",
        summary: { shortText: "Summary." },
        stages: [
          {
            id: "stage_1",
            cue: "Stage one",
            speech: "Stage one speech",
            components: [{ component: "SingleValue", data: { title: "Steps", value: 5000 } }],
          },
        ],
      })
    );

    render(
      <MemoryRouter>
        <QnAPage />
      </MemoryRouter>
    );

    expect(await screen.findByText("Stage one speech")).toBeTruthy();
  });

  test("does not crash when qnaData is malformed JSON", async () => {
    sessionStorage.setItem("qnaData", "{bad-json");

    render(
      <MemoryRouter>
        <QnAPage />
      </MemoryRouter>
    );

    expect(await screen.findByRole("heading", { name: "Health Assistant" })).toBeTruthy();
    expect(screen.getByText("Ask any health question below. Your answer and chart will appear here.")).toBeTruthy();
  });

  test("auto-advances staged charts in order", async () => {
    jest.useFakeTimers();
    const originalFetch = global.fetch;
    const fetchSpy = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
    global.fetch = fetchSpy;

    sessionStorage.setItem(
      "qnaData",
      JSON.stringify({
        question: "Show my trends",
        summary: { shortText: "Summary", shortSpeech: "Summary speech" },
        activeStageIndex: 0,
        stages: [
          {
            id: "stage_1",
            cue: "First",
            speech: "Stage one speech.",
            components: [{ component: "SingleValue", data: { title: "Stage 1", value: 1 } }],
          },
          {
            id: "stage_2",
            cue: "Second",
            speech: "Stage two speech with a few words.",
            components: [{ component: "SingleValue", data: { title: "Stage 2", value: 2 } }],
          },
          {
            id: "stage_3",
            cue: "Third",
            speech: "Stage three speech with a few words.",
            components: [{ component: "SingleValue", data: { title: "Stage 3", value: 3 } }],
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

    await act(async () => {
      jest.advanceTimersByTime(6000);
    });
    expect(await screen.findByRole("heading", { level: 2, name: "Stage 2" })).toBeTruthy();

    await act(async () => {
      jest.advanceTimersByTime(6000);
    });
    expect(await screen.findByRole("heading", { level: 2, name: "Stage 3" })).toBeTruthy();

    expect(fetchSpy).toHaveBeenCalled();
    global.fetch = originalFetch;
    jest.useRealTimers();
  });
});
