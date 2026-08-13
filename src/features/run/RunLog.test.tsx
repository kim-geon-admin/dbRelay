import { render, screen } from "@testing-library/react";
import { RunLog } from "./RunLog";

it("renders an Oracle error code with its Korean name and explanation", () => {
  render(<RunLog events={[{
    type: "step_failed",
    step: 0,
    error: {
      type: "connector",
      detail: { code: "ORA-00001", message: "Database operation failed", retryable: false },
    },
  }]} />);

  expect(screen.getByText(/ORA-00001 · 고유 제약 조건 위반/)).toBeVisible();
  expect(screen.getByText(/동일한 값이 이미 존재/)).toBeVisible();
  expect(screen.queryByText("Database operation failed")).not.toBeInTheDocument();
});
