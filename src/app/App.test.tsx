import { render, screen } from "@testing-library/react";
import { App } from "./App";

it("renders the DB Relay application title", () => {
  render(<App />);
  expect(screen.getByRole("heading", { name: "DB Relay" })).toBeVisible();
});
