import { act, fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { RunDashboard } from "./RunDashboard";
import type { Run } from "./run.types";

const { startRun } = vi.hoisted(() => ({ startRun: vi.fn() }));
vi.mock("./run.api", () => ({ startRun, recoverRun: vi.fn() }));

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
  const connections = [{ id: "source", displayName: "Source", kind: "oracle" as const, host: "a", port: 1, serviceName: "a", username: "a", sourceReadOnly: true, enabled: true }, { id: "target", displayName: "Target", kind: "oracle" as const, host: "b", port: 1, serviceName: "b", username: "b", sourceReadOnly: false, enabled: true }];
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
  const connections = [{ id: "source", displayName: "Source", kind: "oracle" as const, host: "a", port: 1, serviceName: "a", username: "a", sourceReadOnly: true, enabled: true }, { id: "target", displayName: "Target", kind: "oracle" as const, host: "b", port: 1, serviceName: "b", username: "b", sourceReadOnly: false, enabled: true }];
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
  const connections = [{ id: "source", displayName: "Source", kind: "oracle" as const, host: "a", port: 1, serviceName: "a", username: "a", sourceReadOnly: true, enabled: true }, { id: "target", displayName: "Target", kind: "oracle" as const, host: "b", port: 1, serviceName: "b", username: "b", sourceReadOnly: false, enabled: true }];
  render(<RunDashboard initialFlows={[flow]} initialConnections={connections} />);

  fireEvent.click(screen.getByRole("button", { name: "Run" }));

  expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
  resolveRun(rolledBackRun);
});

it("renders the exact tagged connector error received from Rust", () => {
  const run = JSON.parse(`{
    "runId":"run-connector-error","policy":"commit_successes",
    "status":{"awaiting_recovery":{"failed_step":0}},"steps":["failed"],
    "events":[{"type":"step_failed","step":0,"error":{"type":"connector","detail":{"code":"ORA-00001","message":"Unique constraint conflict","retryable":false}}}]
  }`) as Run;

  render(<RunDashboard run={run} />);

  expect(screen.getAllByText(/ORA-00001/)[0]).toBeVisible();
  expect(screen.getAllByText(/Unique constraint conflict/)[0]).toBeVisible();
});
