import { render, screen } from "@testing-library/react";
import { StatusBadge } from "./StatusBadge";

it("shows a readable failed status", () => {
  render(<StatusBadge status="failed" />);

  expect(screen.getByText("실패")).toBeVisible();
});

it("shows a readable successful status", () => {
  render(<StatusBadge status="succeeded" />);

  expect(screen.getByText("성공")).toBeVisible();
});
