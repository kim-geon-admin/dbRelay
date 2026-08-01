import { fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { RecoveryDialog } from "./RecoveryDialog";
import type { Run } from "./run.types";

const run: Run = {
  runId: "run-1",
  policy: "commit_successes",
  status: { awaiting_recovery: { failed_step: 1 } },
  steps: [{ succeeded: { affected_rows: 3 } }, "failed"],
  events: [{ type: "step_failed", step: 1, error: { connector: { code: "ORA-00001", message: "Unique constraint conflict", retryable: false } } }],
};

it("offers exactly the three recovery decisions for a committed-step failure", () => {
  render(<RecoveryDialog run={run} onEditRetry={vi.fn()} onSkip={vi.fn()} onStop={vi.fn()} />);

  expect(screen.getByRole("dialog", { name: /recovery required/i })).toBeVisible();
  expect(screen.getByText("ORA-00001")).toBeVisible();
  expect(screen.getByRole("button", { name: /edit and retry/i })).toBeVisible();
  expect(screen.getByRole("button", { name: /skip and continue/i })).toBeVisible();
  expect(screen.getByRole("button", { name: /^stop$/i })).toBeVisible();
  expect(screen.getAllByRole("button")).toHaveLength(3);
});

it("resets its mode and SQL when a different failed step replaces the run", () => {
  const { rerender } = render(<RecoveryDialog run={run} step={{ id: "step-2", selectSql: "SELECT old", upsertSql: "MERGE old" }} onEditRetry={vi.fn()} onSkip={vi.fn()} onStop={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: /edit and retry/i }));
  expect(screen.getByDisplayValue("SELECT old")).toBeVisible();

  rerender(<RecoveryDialog run={{ ...run, runId: "run-2", status: { awaiting_recovery: { failed_step: 0 } }, steps: ["failed"], events: [{ type: "step_failed", step: 0, error: { connector: { code: "ORA-00002", message: "new failure", retryable: false } } }] }} step={{ id: "step-1", selectSql: "SELECT new", upsertSql: "MERGE new" }} onEditRetry={vi.fn()} onSkip={vi.fn()} onStop={vi.fn()} />);

  expect(screen.getByRole("button", { name: /edit and retry/i })).toBeVisible();
  expect(screen.queryByDisplayValue("SELECT old")).not.toBeInTheDocument();
  expect(screen.queryByRole("textbox", { name: "Source SQL" })).not.toBeInTheDocument();
});

it("focuses the first action, traps Tab, and restores prior focus when closed", () => {
  const trigger = document.createElement("button");
  document.body.append(trigger);
  trigger.focus();
  const view = render(<RecoveryDialog run={run} onEditRetry={vi.fn()} onSkip={vi.fn()} onStop={vi.fn()} />);
  const edit = screen.getByRole("button", { name: /edit and retry/i });
  const stop = screen.getByRole("button", { name: /^stop$/i });
  expect(edit).toHaveFocus();

  fireEvent.keyDown(edit, { key: "Tab", shiftKey: true });
  expect(stop).toHaveFocus();
  fireEvent.keyDown(stop, { key: "Tab" });
  expect(edit).toHaveFocus();

  view.unmount();
  expect(trigger).toHaveFocus();
  trigger.remove();
});

it("moves focus to the first control after every recovery mode transition", () => {
  render(<RecoveryDialog run={run} step={{ id: "step-2", selectSql: "SELECT 1", upsertSql: "MERGE" }} onEditRetry={vi.fn()} onSkip={vi.fn()} onStop={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: /edit and retry/i }));
  const sourceSql = screen.getByRole("textbox", { name: "Source SQL" });
  const targetSql = screen.getByRole("textbox", { name: "Target SQL" });
  expect(sourceSql).toHaveFocus();
  fireEvent.keyDown(sourceSql, { key: "Tab" });
  expect(targetSql).toHaveFocus();

  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  const edit = screen.getByRole("button", { name: /edit and retry/i });
  expect(edit).toHaveFocus();
  fireEvent.keyDown(edit, { key: "Tab" });
  expect(screen.getByRole("button", { name: /skip and continue/i })).toHaveFocus();

  fireEvent.click(screen.getByRole("button", { name: /skip and continue/i }));
  expect(screen.getByRole("button", { name: /confirm skip and continue/i })).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  fireEvent.click(screen.getByRole("button", { name: /^stop$/i }));
  expect(screen.getByRole("button", { name: /confirm stop/i })).toHaveFocus();
});
