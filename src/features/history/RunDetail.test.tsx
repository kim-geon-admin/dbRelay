import { render, screen } from "@testing-library/react";
import { RunDetail } from "./RunDetail";
import type { HistoryRun } from "./history.types";

it("renders a SkippedByUser recovery event without a bind value or source row", () => {
  const run: HistoryRun = {
    runId: "run-3",
    flowId: "customer-relay",
    flowVersion: 3,
    startedAt: 1785542400000,
    endedAt: 1785542460000,
    policy: "commit_successes",
    status: "completed",
    steps: ["skipped_by_user"],
    events: [{ type: "recovery_applied", step: 0, action: "skip_and_continue" }],
  };

  render(<RunDetail run={run} />);

  expect(screen.getByText(/SkippedByUser/)).toBeVisible();
  expect(screen.getByText(/customer-relay v3/)).toBeVisible();
  expect(screen.getByText(/2026-08-01T00:00:00.000Z/)).toBeVisible();
  expect(screen.getByText(/2026-08-01T00:01:00.000Z/)).toBeVisible();
  expect(screen.queryByText(/bind value|source row/i)).not.toBeInTheDocument();
});
