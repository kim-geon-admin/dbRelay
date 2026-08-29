import { render, screen } from "@testing-library/react";
import { App } from "./App";

it("renders database connection settings on its route", () => {
  window.location.hash = "#database-settings";
  render(<App />);
  expect(screen.getByRole("heading", { name: "Connections" })).toBeVisible();
  window.location.hash = "";
});

