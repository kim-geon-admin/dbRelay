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

it("renders Oracle errors in Korean without the driver message", () => {
  const run: HistoryRun = {
    runId: "run-4", flowId: "customer-relay", flowVersion: 3, startedAt: 0, endedAt: 1,
    policy: "all_or_nothing", status: "failed", steps: ["failed"],
    events: [{ type: "transaction_failed", error: {
      type: "connector",
      detail: { code: "ORA-00942", message: "Database operation failed", retryable: false },
    } }],
  };

  render(<RunDetail run={run} />);

  expect(screen.getByText(/ORA-00942 · 테이블 또는 뷰가 존재하지 않음/)).toBeVisible();
  expect(screen.queryByText("Database operation failed")).not.toBeInTheDocument();
});
