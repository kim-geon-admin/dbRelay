import { act, fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { RunDashboard } from "./RunDashboard";
import type { Run } from "./run.types";

const { startRun, subscribeRunProgress, unsubscribeProgress } = vi.hoisted(() => ({
  startRun: vi.fn(),
  subscribeRunProgress: vi.fn(),
  unsubscribeProgress: vi.fn(),
}));
vi.mock("./run.api", () => ({ startRun, recoverRun: vi.fn(), subscribeRunProgress }));

const rolledBackRun: Run = {
  runId: "run-2",
  policy: "all_or_nothing",
  status: "rolled_back",
  steps: ["failed"],
  events: [],
};

it("does not render recovery controls for an all-or-nothing failure", () => {
  render(<RunDashboard run={rolledBackRun} />);

  expect(screen.queryByRole("button", { name: /edit and retry/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /skip and continue/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^stop$/i })).not.toBeInTheDocument();
});

it("disables dashboard controls while recovery owns the keyboard", () => {
  const flow = { id: "flow-1", name: "Flow", sourceConnectionId: "source", targetConnectionId: "target", transactionPolicy: "commit_successes" as const, version: 0, querySteps: [{ id: "step-1", selectSql: "SELECT 1", upsertSql: "MERGE" }] };
  const connections = [{ id: "source", displayName: "Source", kind: "oracle" as const, host: "a", port: 1, sid: "a", username: "a", passwordMask: "", enabled: true }, { id: "target", displayName: "Target", kind: "oracle" as const, host: "b", port: 1, sid: "b", username: "b", passwordMask: "", enabled: true }];
  const waiting: Run = { runId: "run-5", policy: "commit_successes", status: { awaiting_recovery: { failed_step: 0 } }, steps: ["failed"], events: [] };
  render(<RunDashboard run={waiting} initialFlows={[flow]} initialConnections={connections} />);

  expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
});

it("freezes duration when the backend execution response completes", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-01T00:00:00Z"));
  let resolveRun!: (run: Run) => void;
  startRun.mockReturnValueOnce(new Promise<Run>((resolve) => { resolveRun = resolve; }));
  const flow = { id: "flow-1", name: "Flow", sourceConnectionId: "source", targetConnectionId: "target", transactionPolicy: "commit_successes" as const, version: 0, querySteps: [{ id: "step-1", selectSql: "SELECT 1", upsertSql: "MERGE" }] };
  const connections = [{ id: "source", displayName: "Source", kind: "oracle" as const, host: "a", port: 1, sid: "a", username: "a", passwordMask: "", enabled: true }, { id: "target", displayName: "Target", kind: "oracle" as const, host: "b", port: 1, sid: "b", username: "b", passwordMask: "", enabled: true }];
  const view = render(<RunDashboard initialFlows={[flow]} initialConnections={connections} />);
  fireEvent.click(screen.getByRole("button", { name: "Run" }));
  vi.setSystemTime(new Date("2026-08-01T00:00:05Z"));
  await act(async () => { resolveRun({ runId: "run-4", policy: "commit_successes", status: "completed", steps: [{ succeeded: { affected_rows: 1 } }], events: [] }); await Promise.resolve(); });
  expect(screen.getByText("Duration:").parentElement).toHaveTextContent("5s");

  vi.setSystemTime(new Date("2026-08-01T00:01:05Z"));
  view.rerender(<RunDashboard initialFlows={[flow]} initialConnections={connections} />);
  expect(screen.getByText("Duration:").parentElement).toHaveTextContent("5s");
  vi.useRealTimers();
});

it("disables Run while its invocation is in flight", () => {
  let resolveRun!: (run: Run) => void;
  startRun.mockReturnValueOnce(new Promise<Run>((resolve) => { resolveRun = resolve; }));
  const flow = { id: "flow-1", name: "Flow", sourceConnectionId: "source", targetConnectionId: "target", transactionPolicy: "commit_successes" as const, version: 0, querySteps: [{ id: "step-1", selectSql: "SELECT 1", upsertSql: "MERGE" }] };
  const connections = [{ id: "source", displayName: "Source", kind: "oracle" as const, host: "a", port: 1, sid: "a", username: "a", passwordMask: "", enabled: true }, { id: "target", displayName: "Target", kind: "oracle" as const, host: "b", port: 1, sid: "b", username: "b", passwordMask: "", enabled: true }];
  render(<RunDashboard initialFlows={[flow]} initialConnections={connections} />);

  fireEvent.click(screen.getByRole("button", { name: "Run" }));

  expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
  resolveRun(rolledBackRun);
});

it("enables Run when one enabled connection is selected as both source and target", () => {
  const flow = { id: "flow-1", name: "Flow", sourceConnectionId: "source", targetConnectionId: "source", transactionPolicy: "commit_successes" as const, version: 0, querySteps: [{ id: "step-1", selectSql: "SELECT 1", upsertSql: "MERGE" }] };
  const connections = [{ id: "source", displayName: "Source", kind: "oracle" as const, host: "a", port: 1, sid: "a", username: "a", passwordMask: "", enabled: true }];

  render(<RunDashboard initialFlows={[flow]} initialConnections={connections} />);

  expect(screen.getByRole("button", { name: "Run" })).toBeEnabled();
});

it("clears a selected flow when its name no longer matches the filter", () => {
  const dailyFlow = { id: "daily-sync", name: "Daily sync", sourceConnectionId: "source", targetConnectionId: "target", transactionPolicy: "commit_successes" as const, version: 0, querySteps: [{ id: "step-1", selectSql: "SELECT 1", upsertSql: "MERGE" }] };
  const customerFlow = { ...dailyFlow, id: "customer-sync", name: "Customer sync" };
  const connections = [{ id: "source", displayName: "Source", kind: "oracle" as const, host: "a", port: 1, sid: "a", username: "a", passwordMask: "", enabled: true }, { id: "target", displayName: "Target", kind: "oracle" as const, host: "b", port: 1, sid: "b", username: "b", passwordMask: "", enabled: true }];
  render(<RunDashboard initialFlows={[dailyFlow, customerFlow]} initialConnections={connections} />);

  fireEvent.change(screen.getByRole("textbox", { name: "Filter saved flows by name" }), { target: { value: "CUSTOMER" } });

  expect(screen.getByRole("combobox", { name: "Saved flow" })).toHaveValue("");
  expect(screen.queryByRole("option", { name: "Daily sync" })).not.toBeInTheDocument();
  expect(screen.getByRole("option", { name: "Customer sync" })).toBeInTheDocument();
});

it("renders batch progress only while the dashboard run is active", async () => {
  // Would fail if renderer progress was not subscribed, if a batch update did
  // not reach the accessible UI, or if terminal execution left stale progress.
  let reportProgress: (progress: {
    runId: string; step: number; processedRows: number; totalRows: number;
    completedBatches: number; totalBatches: number;
  }) => void = () => undefined;
  subscribeRunProgress.mockImplementationOnce((listener) => {
    reportProgress = listener;
    return unsubscribeProgress;
  });
  let resolveRun!: (run: Run) => void;
  startRun.mockReturnValueOnce(new Promise<Run>((resolve) => { resolveRun = resolve; }));
  const flow = { id: "flow-1", name: "Flow", sourceConnectionId: "source", targetConnectionId: "target", transactionPolicy: "all_or_nothing" as const, version: 0, querySteps: [{ id: "step-1", selectSql: "SELECT 1", upsertSql: "MERGE" }] };
  const connections = [{ id: "source", displayName: "Source", kind: "oracle" as const, host: "a", port: 1, sid: "a", username: "a", passwordMask: "", enabled: true }, { id: "target", displayName: "Target", kind: "oracle" as const, host: "b", port: 1, sid: "b", username: "b", passwordMask: "", enabled: true }];
  const view = render(<RunDashboard initialFlows={[flow]} initialConnections={connections} />);
  fireEvent.click(screen.getByRole("button", { name: "Run" }));

  await act(async () => {
    reportProgress({
      runId: "run-active", step: 0, processedRows: 1_000, totalRows: 2_001,
      completedBatches: 1, totalBatches: 3,
    });
  });

  expect(screen.getByRole("progressbar")).toHaveAttribute("value", "1000");
  expect(screen.getByRole("progressbar")).toHaveAttribute("max", "2001");
  expect(screen.getByText(/1,000.*2,001.*1\/3/u)).toBeVisible();

  await act(async () => { resolveRun({ runId: "run-active", policy: "all_or_nothing", status: "completed", steps: [], events: [] }); });
  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  view.unmount();
  expect(unsubscribeProgress).toHaveBeenCalledOnce();
});

it("renders the tagged connector error in Korean without its driver message", () => {
  const run = JSON.parse(`{
    "runId":"run-connector-error","policy":"commit_successes",
    "status":{"awaiting_recovery":{"failed_step":0}},"steps":["failed"],
    "events":[{"type":"step_failed","step":0,"error":{"type":"connector","detail":{"code":"ORA-00001","message":"Unique constraint conflict","retryable":false}}}]
  }`) as Run;

  render(<RunDashboard run={run} />);

  expect(screen.getAllByText(/ORA-00001/)[0]).toBeVisible();
  expect(screen.getAllByText(/고유 제약 조건 위반/)[0]).toBeVisible();
  expect(screen.queryByText(/Unique constraint conflict/)).not.toBeInTheDocument();
});
