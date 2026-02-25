import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import DashboardPage from "./DashboardPage";
import ReminderPage from "./ReminderPage";
import QnAPage from "./QnAPage";

describe("Smart screen page smoke tests", () => {
  test("renders dashboard page shell", () => {
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    );
    expect(screen.getByRole("heading", { name: "Today's Overview" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Today's Insight" })).toBeTruthy();
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
    expect(screen.getByRole("heading", { name: "Response" })).toBeTruthy();
    expect(screen.getByText("Compare my health this week to last week")).toBeTruthy();
  });
});

