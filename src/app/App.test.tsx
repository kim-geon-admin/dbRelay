import { render, screen } from "@testing-library/react";
import { App } from "./App";

it("renders the 실행 route by default", () => {
  render(<App />);
  expect(screen.getByRole("heading", { name: "실행" })).toBeVisible();
});
