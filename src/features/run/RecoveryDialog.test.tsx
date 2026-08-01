import { render, screen } from "@testing-library/react";
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
