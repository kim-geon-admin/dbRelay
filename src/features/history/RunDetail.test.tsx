import { render, screen } from "@testing-library/react";
import { RunDetail } from "./RunDetail";
import type { HistoryRun } from "./history.types";

it("renders a SkippedByUser recovery event without a bind value or source row", () => {
  const run: HistoryRun = {
    runId: "run-3",
    policy: "commit_successes",
    status: "completed",
    steps: ["skipped_by_user"],
    events: [{ type: "recovery_applied", step: 0, action: "skip_and_continue" }],
  };

  render(<RunDetail run={run} />);

  expect(screen.getByText(/SkippedByUser/)).toBeVisible();
  expect(screen.queryByText(/bind value|source row/i)).not.toBeInTheDocument();
});
