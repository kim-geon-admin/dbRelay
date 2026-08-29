import { render, screen } from "@testing-library/react";
import { AppShell } from "./AppShell";

it("marks the current 실행 route in the primary navigation", () => {
  render(
    <AppShell activeRoute="run">
      <div>content</div>
    </AppShell>,
  );

  expect(screen.getByRole("link", { name: "실행" })).toHaveAttribute(
    "aria-current",
    "page",
  );
});

it("provides all four routes through the primary navigation", () => {
  render(
    <AppShell activeRoute="run">
      <div>content</div>
    </AppShell>,
  );

  expect(screen.getByRole("link", { name: "쿼리 시퀀스" })).toBeVisible();
  expect(screen.getByRole("link", { name: "DB 설정" })).toBeVisible();
  expect(screen.getByRole("link", { name: "실행 이력" })).toBeVisible();
});
