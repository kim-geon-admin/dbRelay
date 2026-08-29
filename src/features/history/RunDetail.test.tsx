import { render, screen } from "@testing-library/react";
import { RunDetail } from "./RunDetail";
import type { HistoryRun } from "./history.types";

it("renders a SkippedByUser recovery event without a bind value or source row", () => {
  const run: HistoryRun = {
    runId: "run-3",
    flowId: "customer-relay",
    flowName: "Customer relay",
    sourceDbName: "Customer source",
    targetDbName: "Customer target",
    flowVersion: 3,
    startedAt: new Date(2026, 7, 1, 9, 0, 0).getTime(),
    endedAt: new Date(2026, 7, 1, 9, 1, 0).getTime(),
    policy: "commit_successes",
    status: "completed",
    steps: ["skipped_by_user"],
    events: [{ type: "recovery_applied", step: 0, action: "skip_and_continue" }],
  };

  render(<RunDetail run={run} />);

  expect(screen.getAllByText("Step 1: skipped by user").length).toBeGreaterThan(0);
  expect(screen.queryByText("Flow: Customer relay")).not.toBeInTheDocument();
  expect(screen.queryByText(/Run ID:|customer-relay v3/)).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Customer source - Customer target - Customer relay" })).toBeVisible();
  expect(screen.getByText(/2026-08-01 09:00:00/)).toBeVisible();
  expect(screen.getByText(/2026-08-01 09:01:00/)).toBeVisible();
  expect(screen.queryByText(/bind value|source row/i)).not.toBeInTheDocument();
});

it("renders Oracle errors in Korean without the driver message", () => {
  const run: HistoryRun = {
    runId: "run-4", flowId: "customer-relay", flowName: "Customer relay", sourceDbName: "Customer source", targetDbName: "Customer target", flowVersion: 3, startedAt: 0, endedAt: 1,
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

it("renders stopped by user with the same normalized status and event format", () => {
  const run: HistoryRun = {
    runId: "run-stopped", flowId: "customer-relay", flowName: "Customer relay",
    sourceDbName: "Customer source", targetDbName: "Customer target", flowVersion: 3,
    startedAt: 0, endedAt: 1, policy: "commit_successes", status: "stopped_by_user",
    steps: [{ succeeded: { affected_rows: 1 } }], events: [{ type: "recovery_applied", step: 0, action: "stop" }],
  };
  render(<RunDetail run={run} />);
  expect(screen.getByText("Status: stopped by user")).toBeVisible();
  expect(screen.getByText("Step 1: stopped by user")).toBeVisible();
});

it("uses captured titles in history results and events", () => {
  const run: HistoryRun = {
    runId: "run-titled", flowId: "flow", flowName: "Flow", sourceDbName: "Source", targetDbName: "Target", flowVersion: 1,
    startedAt: 0, endedAt: 1, policy: "all_or_nothing", status: "completed", stepTitles: ["Load customers"],
    steps: [{ succeeded: { affected_rows: 1 } }], events: [{ type: "step_succeeded", step: 0, affected_rows: 1 }],
  };

  render(<RunDetail run={run} />);

  expect(screen.getAllByText(/Load customers: committed 1 rows/).length).toBeGreaterThan(0);
});
