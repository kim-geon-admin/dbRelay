import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RunHistory } from "./RunHistory";
import type { HistoryRun } from "./history.types";

const { clearRunHistory, deleteRunHistory, listRunHistory } = vi.hoisted(() => ({
  clearRunHistory: vi.fn(),
  deleteRunHistory: vi.fn(),
  listRunHistory: vi.fn(),
}));

vi.mock("./history.api", () => ({ clearRunHistory, deleteRunHistory, listRunHistory }));

const completedRun: HistoryRun = {
  runId: "run-customer-1",
  flowId: "customer-daily",
  flowName: "Customer daily",
  sourceDbName: "Customer source",
  targetDbName: "Customer target",
  flowVersion: 2,
  startedAt: new Date(2026, 8, 5, 8, 44, 33).getTime(),
  endedAt: new Date(2026, 8, 5, 8, 45, 33).getTime(),
  policy: "all_or_nothing",
  status: "completed",
  steps: [{ succeeded: { affected_rows: 2 } }],
  events: [{ type: "step_succeeded", step: 0, affected_rows: 2 }],
};

const awaitingRecoveryRun: HistoryRun = {
  ...completedRun,
  runId: "run-customer-2",
  flowName: "Customer retry",
  endedAt: null,
  status: { awaiting_recovery: { failed_step: 0 } },
  steps: ["failed"],
};

beforeEach(() => {
  vi.clearAllMocks();
  listRunHistory.mockResolvedValue([completedRun, awaitingRecoveryRun]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("renders run history as a single card list instead of a split pane", async () => {
  render(<RunHistory />);

  expect(await screen.findByRole("list", { name: "Run history" })).toBeVisible();
  expect(screen.queryByRole("dialog", { name: "Run details" })).not.toBeInTheDocument();
  expect(screen.getByText("Customer daily")).toBeVisible();
  expect(screen.getByText("Customer retry")).toBeVisible();
  expect(screen.queryByText("Flow: Customer daily")).not.toBeInTheDocument();
  expect(screen.queryByText("Run ID: run-customer-1")).not.toBeInTheDocument();
  expect(screen.getAllByText("Executed: 2026-09-05 08:44:33")).toHaveLength(2);
  expect(screen.queryByRole("heading", { name: "Customer source - Customer target - Customer daily" })).not.toBeInTheDocument();
  expect(document.querySelector(".run-history > aside")).not.toBeInTheDocument();
});

it("shows the most recently started run first", async () => {
  listRunHistory.mockResolvedValue([
    { ...completedRun, runId: "older", startedAt: 1, flowName: "Older" },
    { ...completedRun, runId: "newer", startedAt: 2, flowName: "Newer" },
  ]);
  render(<RunHistory />);
  const list = await screen.findByRole("list", { name: "Run history" });
  expect(list.querySelector(".history-card strong")?.textContent).toBe("Newer");
});

it("renders details directly below the clicked history and closes them when clicked again", async () => {
  render(<RunHistory />);

  await screen.findByRole("list", { name: "Run history" });
  const dailyButton = screen.getByRole("button", { name: "View details for Customer daily" });
  fireEvent.click(dailyButton);

  const detail = screen.getByRole("heading", { name: "Customer source - Customer target - Customer daily" });
  expect(detail).toBeVisible();
  expect(detail.parentElement).toHaveTextContent("2026-09-05 08:44:33");
  expect(screen.queryByRole("dialog", { name: "Run details" })).not.toBeInTheDocument();
  expect(detail.closest("li")).toContainElement(dailyButton);

  fireEvent.click(screen.getByRole("button", { name: "View details for Customer retry" }));

  expect(screen.getByRole("heading", { name: "Customer source - Customer target - Customer retry" })).toBeVisible();
  expect(screen.queryByRole("heading", { name: "Customer source - Customer target - Customer daily" })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "View details for Customer retry" }));

  expect(screen.queryByRole("heading", { name: "Customer source - Customer target - Customer retry" })).not.toBeInTheDocument();
});

it("deletes a completed run after confirmation", async () => {
  deleteRunHistory.mockResolvedValue(undefined);
  render(<RunHistory />);

  fireEvent.click(await screen.findByRole("button", { name: "Delete Customer daily" }));
  const dialog = screen.getByRole("alertdialog", { name: "실행이력 삭제" });
  expect(deleteRunHistory).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "삭제" }));

  expect(deleteRunHistory).toHaveBeenCalledWith("run-customer-1");
  expect(await screen.findByRole("status")).toHaveTextContent("Run history deleted.");
  expect(screen.queryByText("Customer daily")).not.toBeInTheDocument();
});

it("disables deletion while a run is awaiting recovery", async () => {
  render(<RunHistory />);

  expect(await screen.findByRole("button", { name: "Delete Customer retry" })).toBeDisabled();
});

it("deletes every history entry after confirmation", async () => {
  clearRunHistory.mockResolvedValue(2);
  render(<RunHistory />);

  fireEvent.click(await screen.findByRole("button", { name: "Delete all history" }));
  const dialog = screen.getByRole("alertdialog", { name: "실행이력 전체 삭제" });
  expect(clearRunHistory).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "전체 삭제" }));

  expect(clearRunHistory).toHaveBeenCalledWith();
  expect(await screen.findByRole("status")).toHaveTextContent("2 run histories deleted.");
  expect(screen.queryByRole("list", { name: "Run history" })).not.toBeInTheDocument();
});
