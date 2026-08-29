import { render, screen } from "@testing-library/react";
import { RunLog } from "./RunLog";

it("renders a known Oracle failure in Korean without its driver message", () => {
  render(<RunLog events={[{
    type: "step_failed",
    step: 0,
    error: {
      type: "connector",
      detail: { code: "ORA-00001", message: "Database operation failed", retryable: false },
    },
  }]} />);

  const log = screen.getByRole("region", { name: "Run log" });
  expect(log).toHaveTextContent("1단계 실행 실패 — Oracle 오류 코드: ORA-00001.");
  expect(log).toHaveTextContent("ORA-00001");
  expect(log).not.toHaveTextContent("Step 1 failed");
  expect(screen.queryByText("Database operation failed")).not.toBeInTheDocument();
});

it("uses the captured title for step events", () => {
  render(<RunLog stepTitles={["Load customers"]} events={[{ type: "step_succeeded", step: 0, affected_rows: 2 }]} />);

  expect(screen.getByRole("region", { name: "Run log" })).toHaveTextContent("Load customers");
});
